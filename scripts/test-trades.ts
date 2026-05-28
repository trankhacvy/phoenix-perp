/**
 * REAL trade-driven test for the paths that need an on-chain action:
 *   monitor  → open+close a tiny BTC position; HiYGtw wired as a *monitored*
 *              wallet so the user receives monitor_open / monitor_fill / monitor_close.
 *   flip     → open a tiny BTC long, then an oversized BTC sell to flip it short;
 *              HiYGtw wired as *owner* so the user receives tpsl_flip. Then close.
 *
 * Trades sign with DEV_SIGNER_SECRET_KEY, so this MUST run with NODE_ENV != production:
 *   NODE_ENV=development pnpm exec tsx scripts/test-trades.ts monitor
 *   NODE_ENV=development pnpm exec tsx scripts/test-trades.ts flip
 *
 * Uses a small ~$5 notional on BTC (cross) and `eco` fees; aborts if notional > $25.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { users } from "../src/db/schema/index.js";
import { startAlertWorker, stopAlertWorker } from "../src/jobs/processors/alert.js";
import { closePhoenixWsClient } from "../src/services/phoenix/client.js";
import { getMarketSnapshot } from "../src/services/phoenix/market.js";
import { stopMarketStatsFeed } from "../src/services/phoenix/market-stats-feed.js";
import { startPriceFeed, stopPriceFeed } from "../src/services/phoenix/price-feed.js";
import { marginToTokens } from "../src/services/phoenix/lots.js";
import { closePosition, getFeeConfig, placeMarketOrder } from "../src/services/phoenix/trade.js";
import { startEvalLoop, stopEvalLoop } from "../src/workers/eval-loop.js";
import { startRestRefreshLoop, stopRestRefreshLoop } from "../src/workers/rest-refresh.js";
import {
  getSnapshot,
  subscribeMonitored,
  subscribeUser,
  unsubscribeUser,
} from "../src/workers/ws.js";

const WALLET = process.env.TEST_WALLET ?? "HiYGtwBa7UwpJf4XnRDkDmKgRi8QgnM3LAfV23Cmjf6h";
const MARKET = "BTC";
const MARGIN_USDC = 2;
const LEVERAGE = 5;
const MAX_NOTIONAL = 25;
const MODE = (process.argv[2] ?? "monitor").toLowerCase();

const fee = getFeeConfig("eco");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(label: string, fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(1000);
  }
  console.log(`  … timed out waiting for ${label}`);
  return false;
}

function heldBtcLots(): number {
  const snap = getSnapshot(WALLET);
  const p = snap?.positions.find((x) => x.symbol === MARKET);
  return p ? p.basePositionLots : 0;
}

async function tinyTradeUnits(): Promise<{ baseUnits: string; decimals: number; mark: number }> {
  const snap = await getMarketSnapshot(MARKET);
  const baseUnits = marginToTokens(snap, MARGIN_USDC, LEVERAGE);
  const notional = Number(baseUnits) * snap.markPrice;
  if (notional > MAX_NOTIONAL) {
    throw new Error(`Computed notional $${notional.toFixed(2)} exceeds guard $${MAX_NOTIONAL}`);
  }
  console.log(`  size ${baseUnits} ${MARKET} (~$${notional.toFixed(2)} notional, mark $${snap.markPrice})`);
  return { baseUnits, decimals: snap.baseLotsDecimals, mark: snap.markPrice };
}

async function runMonitor(telegramId: string) {
  console.log("MODE: monitor (HiYGtw wired as a monitored wallet)\n");
  await subscribeMonitored(WALLET, telegramId);
  await waitUntil("snapshot", () => getSnapshot(WALLET) !== undefined, 30_000);

  const { baseUnits } = await tinyTradeUnits();

  console.log("▶ opening tiny BTC long → expect monitor_open + monitor_fill");
  const sig1 = await placeMarketOrder({ symbol: MARKET, side: "long", baseUnits, walletAddress: WALLET }, fee);
  console.log(`  tx ${sig1}`);
  await sleep(8000);

  console.log("▶ closing BTC → expect monitor_close + monitor_fill");
  const sig2 = await closePosition(MARKET, WALLET, 1, fee);
  console.log(`  tx ${sig2}`);
  await sleep(8000);
  console.log("Check Telegram for 👁 monitor alerts.");
}

async function runFlip(telegramId: string) {
  console.log("MODE: flip (HiYGtw wired as owner)\n");
  await subscribeUser(WALLET, telegramId);
  await waitUntil("snapshot", () => getSnapshot(WALLET) !== undefined, 30_000);

  if (heldBtcLots() !== 0) {
    console.log("  BTC position already open — closing it first to start flat");
    await closePosition(MARKET, WALLET, 1, fee);
    await sleep(6000);
  }

  const { baseUnits, decimals } = await tinyTradeUnits();

  console.log("▶ opening tiny BTC long");
  await placeMarketOrder({ symbol: MARKET, side: "long", baseUnits, walletAddress: WALLET }, fee);
  await waitUntil("BTC long in cache", () => heldBtcLots() > 0, 20_000);
  await sleep(2000);

  const sellUnits = (Number(baseUnits) * 2).toFixed(decimals);
  console.log(`▶ market sell ${sellUnits} BTC → flips long→short → expect tpsl_flip`);
  await placeMarketOrder({ symbol: MARKET, side: "short", baseUnits: sellUnits, walletAddress: WALLET }, fee);
  await waitUntil("BTC flipped short", () => heldBtcLots() < 0, 20_000);
  await sleep(6000);

  console.log("▶ closing BTC short to return flat");
  await closePosition(MARKET, WALLET, 1, fee);
  await sleep(4000);
  console.log("Check Telegram for the 🔄 tpsl_flip alert.");
}

async function main() {
  const user = await db.query.users.findFirst({ where: eq(users.walletAddress, WALLET) });
  if (!user) {
    console.error(`No user for wallet ${WALLET}`);
    process.exit(1);
  }
  console.log(`Trade test for ${WALLET}  telegramId=${user.telegramId}  mode=${MODE}\n`);

  startAlertWorker();
  startRestRefreshLoop();
  startPriceFeed();
  startEvalLoop();

  try {
    if (MODE === "flip") await runFlip(user.telegramId);
    else await runMonitor(user.telegramId);
  } catch (err) {
    console.error("Trade test error:", err);
  }

  await sleep(1500);
  unsubscribeUser(WALLET);
  stopEvalLoop();
  stopPriceFeed();
  stopMarketStatsFeed();
  stopRestRefreshLoop();
  closePhoenixWsClient();
  await stopAlertWorker();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
