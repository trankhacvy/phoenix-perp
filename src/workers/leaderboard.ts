import { logger } from "../lib/logger.js";
import { TokenBucket } from "../lib/rate-limiter.js";
import { redis } from "../lib/redis.js";
import {
  backfillStaleTraders,
  discoverBotUserWallets,
  discoverTraderWallets,
  hydrateTradersBatch,
  seedFromGpa,
  syncWalletTags,
  upsertAndHydrateWallet,
} from "../services/leaderboard.js";
import { getMarkets } from "../services/phoenix/market.js";
import { subscribeMarketTakers } from "../services/phoenix/trades-feed.js";

const log = logger.child({ worker: "leaderboard" });

const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const HISTORY_INTERVAL_MS = 2 * 60 * 60 * 1000;
const WS_DEDUP_TTL = 3600;

// Worker rate limiter: 0.5 wallets/sec sustained (1 every 2s), burst up to 2.
// Each wallet = 1-3 Phoenix API calls → keeps worker at ~1-2 req/s.
// Phoenix 429'd us at ~5 req/s, so this stays well under.
const workerRateLimiter = new TokenBucket(2, 0.5);

let shuttingDown = false;
let scanInFlight: Promise<void> | null = null;
let scanIntervalId: ReturnType<typeof setInterval> | null = null;
let historyIntervalId: ReturnType<typeof setInterval> | null = null;

const tradeUnsubs = new Map<string, () => void>();

function handleDiscoveredTaker(symbol: string, taker: string) {
  void (async () => {
    try {
      const isNew = await redis.set(`lb:known:${taker}`, "1", "EX", WS_DEDUP_TTL, "NX");
      if (!isNew) return;
      log.debug({ taker, symbol }, "New trader discovered via WS");
      await upsertAndHydrateWallet(taker, workerRateLimiter);
    } catch (err) {
      log.warn({ taker, symbol, err }, "Failed to process discovered trader");
    }
  })();
}

function subscribeTradesForMarket(symbol: string) {
  if (shuttingDown || tradeUnsubs.has(symbol)) return;
  const unsub = subscribeMarketTakers(symbol, (taker) => handleDiscoveredTaker(symbol, taker));
  tradeUnsubs.set(symbol, unsub);
}

async function subscribeAllMarketTrades() {
  try {
    const markets = await getMarkets();
    for (const m of markets) subscribeTradesForMarket(m.symbol);
    log.info({ count: markets.length }, "WS trades subscriptions started");
  } catch (err) {
    log.error({ err }, "Failed to subscribe to market trades");
  }
}

export async function startLeaderboardScanner() {
  log.info("Leaderboard scanner starting");

  // Phase 1: Wallet tags
  log.info("[Phase 1/5] Syncing wallet tags...");
  await syncWalletTags().catch((err) => log.warn({ err }, "Wallet tags sync failed"));

  // Phase 2: GPA discovery
  log.info("[Phase 2/5] Running GPA discovery...");
  const traders = await discoverTraderWallets().catch((err) => {
    log.warn({ err }, "GPA discovery failed");
    return [];
  });
  log.info({ traders: traders.length }, "[Phase 2/5] GPA discovery done");

  // Phase 3: Seed + hydrate changed
  if (traders.length > 0) {
    log.info("[Phase 3/5] Seeding DB from GPA...");
    const { inserted, updated, changedWallets } = await seedFromGpa(traders);
    log.info({ inserted, updated, changed: changedWallets.length }, "[Phase 3/5] GPA seed done");

    if (changedWallets.length > 0) {
      log.info({ count: changedWallets.length }, "[Phase 3/5] Hydrating changed traders...");
      const hydrated = await hydrateTradersBatch(changedWallets, {
        concurrency: 2,
        includeHistory: true,
        rateLimiter: workerRateLimiter,
      });
      log.info(
        { changed: changedWallets.length, hydrated },
        "[Phase 3/5] Changed traders hydrated",
      );
    } else {
      log.info("[Phase 3/5] No changed traders, skipping hydration");
    }
  } else {
    log.info("[Phase 3/5] No traders from GPA, skipping seed");
  }

  // Phase 4: Bot user wallets
  log.info("[Phase 4/5] Discovering bot user wallets...");
  const botWallets = await discoverBotUserWallets();
  if (botWallets.size > 0) {
    log.info({ count: botWallets.size }, "[Phase 4/5] Hydrating bot users...");
    const hydrated = await hydrateTradersBatch(Array.from(botWallets), {
      concurrency: 2,
      includeHistory: true,
      rateLimiter: workerRateLimiter,
    });
    log.info({ botUsers: botWallets.size, hydrated }, "[Phase 4/5] Bot users hydrated");
  } else {
    log.info("[Phase 4/5] No bot users found");
  }

  // Phase 5: WS subscriptions
  log.info("[Phase 5/5] Subscribing to market trades...");
  await subscribeAllMarketTrades();

  // --- Backfill cycle: time-based safety net for stale data ---
  scanIntervalId = setInterval(() => {
    if (scanInFlight) {
      log.debug("Backfill skipped, previous scan still in flight");
      return;
    }
    log.info("[30m backfill] Starting stale trader backfill...");
    scanInFlight = backfillStaleTraders(false, workerRateLimiter)
      .then((n) => log.info({ backfilled: n }, "[30m backfill] Done"))
      .catch((err) => log.error({ err }, "[30m backfill] Failed"))
      .finally(() => {
        scanInFlight = null;
      });
  }, SCAN_INTERVAL_MS);

  // --- Full rescan: GPA slot diff + hydrate only changed ---
  historyIntervalId = setInterval(() => {
    if (scanInFlight) {
      log.debug("Full rescan skipped, previous scan still in flight");
      return;
    }
    log.info("[2h rescan] Starting full GPA rescan...");
    scanInFlight = (async () => {
      const fresh = await discoverTraderWallets().catch((err) => {
        log.warn({ err }, "[2h rescan] GPA re-scan failed");
        return [];
      });

      if (fresh.length > 0) {
        log.info({ discovered: fresh.length }, "[2h rescan] GPA done, seeding...");
        const { changedWallets } = await seedFromGpa(fresh);
        if (changedWallets.length > 0) {
          log.info({ changed: changedWallets.length }, "[2h rescan] Hydrating changed...");
          await hydrateTradersBatch(changedWallets, {
            concurrency: 2,
            includeHistory: true,
            rateLimiter: workerRateLimiter,
          });
        }
        log.info(
          { discovered: fresh.length, changed: changedWallets.length },
          "[2h rescan] Rescan done",
        );
      }

      log.info("[2h rescan] Backfilling stale traders with history...");
      const backfilled = await backfillStaleTraders(true, workerRateLimiter);
      log.info({ backfilled }, "[2h rescan] Backfill done");
    })()
      .catch((err) => log.error({ err }, "[2h rescan] Failed"))
      .finally(() => {
        scanInFlight = null;
      });
  }, HISTORY_INTERVAL_MS);

  log.info(
    {
      scanIntervalMin: SCAN_INTERVAL_MS / 60_000,
      historyIntervalMin: HISTORY_INTERVAL_MS / 60_000,
    },
    "Leaderboard scanner ready",
  );
}

export async function stopLeaderboardScanner() {
  shuttingDown = true;
  if (scanIntervalId) clearInterval(scanIntervalId);
  if (historyIntervalId) clearInterval(historyIntervalId);
  for (const [, unsub] of tradeUnsubs) unsub();
  tradeUnsubs.clear();
  if (scanInFlight) await scanInFlight.catch(() => {});
}

export function getLeaderboardScannerStats() {
  return {
    tradeSubscriptions: tradeUnsubs.size,
    isScanning: scanInFlight !== null,
  };
}
