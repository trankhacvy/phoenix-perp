/**
 * REAL end-to-end test. Boots the actual worker stack (traderState WS + allMids
 * price feed + marketStats + REST refresh + eval loop + alert worker) against a
 * live wallet, then creates Guardian rules whose thresholds the wallet's REAL
 * current position crosses. Every alert is driven by live WebSocket/REST data —
 * nothing about the position/price/PnL/liq is synthetic.
 *
 * Requires the wallet to have an open position.
 *
 * Run:  pnpm exec tsx scripts/test-live.ts
 *       TEST_WALLET=<addr> pnpm exec tsx scripts/test-live.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { alertSubscriptions, users } from "../src/db/schema/index.js";
import { startAlertWorker, stopAlertWorker } from "../src/jobs/processors/alert.js";
import { redis } from "../src/lib/redis.js";
import { closePhoenixWsClient } from "../src/services/phoenix/client.js";
import { getStats, stopMarketStatsFeed } from "../src/services/phoenix/market-stats-feed.js";
import { getMid, startPriceFeed, stopPriceFeed } from "../src/services/phoenix/price-feed.js";
import {
  createRule,
  deleteRule,
  generateRuleId,
  getUserRules,
} from "../src/services/guardian.js";
import { startEvalLoop, stopEvalLoop } from "../src/workers/eval-loop.js";
import {
  bustPriceAlertCache,
  startPriceAlertWatcher,
  stopPriceAlertWatcher,
} from "../src/workers/evaluators/price-alert.js";
import {
  getRestDerived,
  startRestRefreshLoop,
  stopRestRefreshLoop,
} from "../src/workers/rest-refresh.js";
import { getSnapshot, subscribeUser, unsubscribeUser } from "../src/workers/ws.js";
import type { GuardianRule } from "../src/db/schema/guardian.js";

const WALLET = process.env.TEST_WALLET ?? "HiYGtwBa7UwpJf4XnRDkDmKgRi8QgnM3LAfV23Cmjf6h";

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

async function clearGuardianDedup(telegramId: string) {
  const keys = await redis.keys(`alert:dedup:${telegramId}:guardian:*`);
  if (keys.length > 0) await redis.del(...keys);
}

async function runRule(
  userId: string,
  telegramId: string,
  label: string,
  def: { ruleType: GuardianRule["ruleType"]; threshold: string; direction: string },
) {
  await clearGuardianDedup(telegramId);
  const id = generateRuleId();
  await createRule({
    id,
    userId,
    ruleType: def.ruleType,
    symbol: null,
    threshold: def.threshold,
    direction: def.direction,
    action: "suggest",
  });
  console.log(`▶ ${label}`);
  const ok = await pollFired(userId, id, 18_000);
  console.log(ok ? `  ✓ FIRED from real data → Telegram` : `  ✗ did NOT fire in 18s`);
  await deleteRule(id, userId);
  await sleep(1000);
}

async function pollFired(userId: string, ruleId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rules = await getUserRules(userId);
    const r = rules.find((x) => x.id === ruleId);
    if (r?.lastTriggeredAt) return true;
    await sleep(1000);
  }
  return false;
}

async function runPriceReal(userId: string, symbol: string, mark: number) {
  // Save the user's existing enabled price alerts for this symbol so the global
  // checkPriceAlerts scan can't permanently disable them.
  const existing = await db
    .select()
    .from(alertSubscriptions)
    .where(
      and(
        eq(alertSubscriptions.userId, userId),
        eq(alertSubscriptions.type, "price"),
        eq(alertSubscriptions.symbol, symbol),
        eq(alertSubscriptions.enabled, true),
      ),
    );
  const savedIds = existing.map((e) => e.id);

  const id = randomUUID();
  const trigger = mark - 0.05;
  await db.insert(alertSubscriptions).values({
    id,
    userId,
    type: "price",
    symbol,
    triggerPrice: String(trigger),
    enabled: true,
  });
  bustPriceAlertCache();
  startPriceAlertWatcher();
  console.log(`▶ price alert ${symbol} at $${trigger.toFixed(2)} (live mark $${mark.toFixed(2)})`);

  let fired = false;
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    const [row] = await db.select().from(alertSubscriptions).where(eq(alertSubscriptions.id, id));
    if (row && row.enabled === false) {
      fired = true;
      break;
    }
    await sleep(1000);
  }
  console.log(fired ? "  ✓ FIRED from real allMids tick → Telegram" : "  ✗ did NOT fire in 18s");

  stopPriceAlertWatcher();
  await db.delete(alertSubscriptions).where(eq(alertSubscriptions.id, id));
  for (const sid of savedIds) {
    await db.update(alertSubscriptions).set({ enabled: true }).where(eq(alertSubscriptions.id, sid));
  }
  bustPriceAlertCache();
  if (savedIds.length > 0) console.log(`  (restored ${savedIds.length} of your existing ${symbol} price alert(s))`);
  await sleep(1000);
}

async function main() {
  const user = await db.query.users.findFirst({ where: eq(users.walletAddress, WALLET) });
  if (!user) {
    console.error(`No user for wallet ${WALLET}`);
    process.exit(1);
  }
  const userId = user.id;
  const telegramId = user.telegramId;
  console.log(`Live test for ${WALLET}  telegramId=${telegramId}\n`);

  startAlertWorker();
  startRestRefreshLoop();
  startPriceFeed();
  startEvalLoop();
  await subscribeUser(WALLET, telegramId);
  console.log("Booted real stack. Waiting for live data…\n");

  const haveSnap = await waitUntil(
    "traderState snapshot",
    () => (getSnapshot(WALLET)?.positions.length ?? 0) > 0,
    30_000,
  );
  if (!haveSnap) {
    console.log("No open positions on the live feed — open one and re-run.");
    await shutdown();
    return;
  }

  const snap = getSnapshot(WALLET);
  if (!snap) {
    await shutdown();
    return;
  }
  const first = snap.positions[0];

  await waitUntil(
    "live price",
    () => (getStats(first.symbol)?.markPrice ?? getMid(first.symbol)) !== undefined,
    15_000,
  );
  const restReady = await waitUntil("REST refresh", () => getRestDerived(WALLET) !== undefined, 25_000);

  console.log("\nLIVE values the eval loop is using:");
  let totalExposure = 0;
  for (const p of snap.positions) {
    const mark = getStats(p.symbol)?.markPrice ?? getMid(p.symbol) ?? p.entryPrice;
    const uPnl = (p.side === "long" ? mark - p.entryPrice : p.entryPrice - mark) * p.sizeTokens;
    const notional = p.sizeTokens * mark;
    totalExposure += notional;
    console.log(
      `  ${p.symbol} ${p.side} | size ${p.sizeTokens} | entry $${p.entryPrice} | mark $${mark.toFixed(4)} | uPnL $${uPnl.toFixed(2)} | notional $${notional.toFixed(2)}`,
    );
  }
  console.log(`  collateral $${snap.depositedCollateralUsdc.toFixed(2)} | exposure $${totalExposure.toFixed(2)}`);
  const rest = getRestDerived(WALLET);
  if (rest) {
    console.log(
      `  REST riskTier=${rest.riskTier} effColl=$${rest.effectiveCollateralUsdc.toFixed(2)} liq=${JSON.stringify(rest.liqPriceBySymbol)}`,
    );
  }
  console.log("");

  // exposure_limit — needs only snapshot + mids
  await runRule(userId, telegramId, `exposure_limit > $${Math.floor(totalExposure) - 5}`, {
    ruleType: "exposure_limit",
    threshold: String(Math.max(1, Math.floor(totalExposure) - 5)),
    direction: "above",
  });

  // pnl_target — uses real uPnL / subaccount collateral
  const markFirst = getStats(first.symbol)?.markPrice ?? getMid(first.symbol) ?? first.entryPrice;
  const uPnlFirst =
    (first.side === "long" ? markFirst - first.entryPrice : first.entryPrice - markFirst) *
    first.sizeTokens;
  const marginFirst = snap.collateralBySub[first.subaccountIndex] ?? snap.depositedCollateralUsdc;
  const pnlPct = (uPnlFirst / marginFirst) * 100;
  if (Math.abs(pnlPct) >= 2) {
    const below = pnlPct < 0;
    const threshold = Math.max(1, Math.floor(Math.abs(pnlPct)) - 1);
    await runRule(
      userId,
      telegramId,
      `pnl_target ${below ? "below −" : "above +"}${threshold}% (live ${pnlPct.toFixed(1)}%)`,
      { ruleType: "pnl_target", threshold: String(threshold), direction: below ? "below" : "above" },
    );
  } else {
    console.log(`▶ pnl_target skipped (live PnL ${pnlPct.toFixed(1)}% too close to 0 to set a safe threshold)\n`);
  }

  // liq_distance — uses real REST liq price vs live mark
  const liq = rest?.liqPriceBySymbol[first.symbol] ?? 0;
  if (restReady && liq > 0 && markFirst > 0) {
    const dist = (Math.abs(markFirst - liq) / markFirst) * 100;
    const threshold = Math.ceil(dist) + 2;
    await runRule(
      userId,
      telegramId,
      `liq_distance < ${threshold}% (live ${dist.toFixed(1)}%, liq $${liq})`,
      { ruleType: "liq_distance", threshold: String(threshold), direction: "below" },
    );
  } else {
    console.log("▶ liq_distance skipped (no REST liq price available)\n");
  }

  // price alert — real allMids tick drives the real price-alert watcher
  await runPriceReal(userId, first.symbol, markFirst);

  console.log("Done — check Telegram for the alerts above.");
  await sleep(1500);
  await shutdown();
}

async function shutdown() {
  unsubscribeUser(WALLET);
  stopPriceAlertWatcher();
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
