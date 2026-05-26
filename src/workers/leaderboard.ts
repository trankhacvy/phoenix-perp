import WebSocket from "ws";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
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

const log = logger.child({ worker: "leaderboard" });

const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const HISTORY_INTERVAL_MS = 2 * 60 * 60 * 1000;
const HYDRATION_CONCURRENCY = 2;
const WS_DEDUP_TTL = 3600;
const MAX_RECONNECT_FAILURES = 3;

let shuttingDown = false;
let scanInFlight: Promise<void> | null = null;
let scanIntervalId: ReturnType<typeof setInterval> | null = null;
let historyIntervalId: ReturnType<typeof setInterval> | null = null;

const tradeWsConnections = new Map<string, WebSocket>();
const reconnectFailures = new Map<string, number>();

function subscribeTradesForMarket(symbol: string) {
  if (shuttingDown) return;

  const ws = new WebSocket(config.PHOENIX_WS_URL);

  ws.on("open", () => {
    reconnectFailures.delete(symbol);
    ws.send(
      JSON.stringify({
        type: "subscribe",
        subscription: { channel: "trades", symbol },
      }),
    );
    log.debug({ symbol }, "WS trades subscribed");
  });

  ws.on("message", async (raw) => {
    let msg: { channel?: string; trades?: { taker?: string }[] };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.channel !== "trades" || !msg.trades) return;

    for (const trade of msg.trades) {
      const taker = trade.taker;
      if (!taker) continue;

      try {
        const dedupKey = `lb:known:${taker}`;
        const isNew = await redis.set(dedupKey, "1", "EX", WS_DEDUP_TTL, "NX");
        if (!isNew) continue;

        log.debug({ taker, symbol }, "New trader discovered via WS");
        await upsertAndHydrateWallet(taker);
      } catch (err) {
        log.warn({ taker, symbol, err }, "Failed to process discovered trader");
      }
    }
  });

  ws.on("close", () => {
    tradeWsConnections.delete(symbol);
    if (shuttingDown) return;

    const failures = (reconnectFailures.get(symbol) ?? 0) + 1;
    reconnectFailures.set(symbol, failures);

    if (failures > MAX_RECONNECT_FAILURES) {
      log.error({ symbol, failures }, "WS trades max reconnect failures reached, giving up");
      return;
    }

    log.warn({ symbol, failures }, "WS trades connection closed, reconnecting in 5s");
    setTimeout(() => subscribeTradesForMarket(symbol), 5000);
  });

  ws.on("error", (err) => {
    log.error({ symbol, err: err.message }, "WS trades error");
  });

  tradeWsConnections.set(symbol, ws);
}

async function subscribeAllMarketTrades() {
  try {
    const markets = await getMarkets();
    for (const m of markets) {
      if (!tradeWsConnections.has(m.symbol)) {
        subscribeTradesForMarket(m.symbol);
      }
    }
    log.info({ count: markets.length }, "WS trades subscriptions started");
  } catch (err) {
    log.error({ err }, "Failed to subscribe to market trades");
  }
}

export async function startLeaderboardScanner() {
  log.info("Leaderboard scanner starting");

  await syncWalletTags().catch((err) => log.warn({ err }, "Wallet tags sync failed"));

  const traders = await discoverTraderWallets().catch((err) => {
    log.warn({ err }, "GPA discovery failed");
    return [];
  });

  console.log("traders", traders.length, traders?.[0]);

  if (traders.length > 0) {
    await seedFromGpa(traders);
  }

  const botWallets = await discoverBotUserWallets();
  console.log("botWallets", botWallets.size, Array.from(botWallets)[0]);
  if (botWallets.size > 0) {
    const hydrated = await hydrateTradersBatch(Array.from(botWallets), HYDRATION_CONCURRENCY, true);
    log.info({ botUsers: botWallets.size, hydrated }, "Bot users hydrated");
  }

  await subscribeAllMarketTrades();

  console.log("Starting backfill cycle");

  scanIntervalId = setInterval(() => {
    if (scanInFlight) return;
    scanInFlight = backfillStaleTraders(false)
      .then((n) => log.info({ backfilled: n }, "Backfill cycle done"))
      .catch((err) => log.error({ err }, "Backfill failed"))
      .finally(() => {
        scanInFlight = null;
      });
  }, SCAN_INTERVAL_MS);
  console.log("Backfill cycle started with interval", SCAN_INTERVAL_MS / 60000, "minutes");
  historyIntervalId = setInterval(() => {
    if (scanInFlight) return;
    scanInFlight = (async () => {
      const fresh = await discoverTraderWallets().catch((err) => {
        log.warn({ err }, "GPA re-scan failed");
        return [];
      });
      if (fresh.length > 0) await seedFromGpa(fresh);
      await backfillStaleTraders(true);
    })()
      .catch((err) => log.error({ err }, "Full scan failed"))
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
  for (const [, ws] of tradeWsConnections) ws.close();
  if (scanInFlight) await scanInFlight.catch(() => {});
}

export function getLeaderboardScannerStats() {
  return {
    wsConnections: tradeWsConnections.size,
    isScanning: scanInFlight !== null,
  };
}
