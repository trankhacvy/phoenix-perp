import WebSocket from "ws";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import {
  discoverTraderWallets,
  hydrateTradersBatch,
  upsertDiscoveredWallet,
} from "../services/leaderboard.js";
import { getMarkets } from "../services/phoenix/market.js";

const log = logger.child({ worker: "leaderboard" });

const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const HISTORY_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const HYDRATION_CONCURRENCY = 5;
const WS_DEDUP_TTL = 3600; // 1 hour
const MAX_RECONNECT_FAILURES = 3;

let shuttingDown = false;
let scanInFlight: Promise<void> | null = null;
let scanIntervalId: ReturnType<typeof setInterval> | null = null;
let historyIntervalId: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// WS: Subscribe to trades channel per market to discover new wallets
// ---------------------------------------------------------------------------

const tradeWsConnections = new Map<string, WebSocket>();
const reconnectFailures = new Map<string, number>();

function subscribeTradesForMarket(symbol: string) {
  if (shuttingDown) return;

  const ws = new WebSocket(config.PHOENIX_WS_URL);

  ws.on("open", () => {
    reconnectFailures.delete(symbol);
    ws.send(JSON.stringify({ type: "subscribe", subscription: { channel: "trades", symbol } }));
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
        await upsertDiscoveredWallet(taker);
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

// ---------------------------------------------------------------------------
// Scan cycle: GPA discovery + REST hydration
// ---------------------------------------------------------------------------

async function runFullScan(includeHistory: boolean) {
  const start = Date.now();
  log.info({ includeHistory }, "Starting leaderboard scan");

  try {
    const wallets = await discoverTraderWallets();
    const walletsArray = Array.from(wallets);

    const upserted = await hydrateTradersBatch(walletsArray, HYDRATION_CONCURRENCY, includeHistory);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log.info(
      { discovered: wallets.size, upserted, includeHistory, elapsedSec: elapsed },
      "Leaderboard scan complete",
    );
  } catch (err) {
    log.error({ err }, "Leaderboard scan failed");
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  log.info("Leaderboard worker starting");

  // Phase 1: Initial full scan with trade history
  await runFullScan(true);

  // Phase 2: Subscribe to WS trades for all markets to discover new traders
  await subscribeAllMarketTrades();

  // Phase 3: Schedule periodic re-scans
  scanIntervalId = setInterval(() => {
    scanInFlight = runFullScan(false);
  }, SCAN_INTERVAL_MS);

  historyIntervalId = setInterval(() => {
    scanInFlight = runFullScan(true);
  }, HISTORY_INTERVAL_MS);

  log.info(
    {
      scanIntervalMin: SCAN_INTERVAL_MS / 60_000,
      historyIntervalMin: HISTORY_INTERVAL_MS / 60_000,
    },
    "Leaderboard worker ready",
  );
}

bootstrap().catch((err) => {
  log.fatal({ err }, "Leaderboard worker bootstrap failed");
  process.exit(1);
});

process.on("SIGTERM", async () => {
  log.info("SIGTERM received, shutting down");
  shuttingDown = true;
  if (scanIntervalId) clearInterval(scanIntervalId);
  if (historyIntervalId) clearInterval(historyIntervalId);
  for (const [, ws] of tradeWsConnections) ws.close();
  if (scanInFlight) await scanInFlight.catch(() => {});
  process.exit(0);
});
