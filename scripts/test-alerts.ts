/**
 * Drives the real alert pipeline end-to-end as if the user hit each trigger.
 *
 * It looks up the target user from the DB, starts the real BullMQ alert worker
 * (so messages actually land in their Telegram), then calls each evaluator with
 * synthetic data crafted to cross the thresholds. No trades, no market moves.
 *
 * Run:   pnpm exec tsx scripts/test-alerts.ts [scenario]
 *   scenario = all | price | risk | guardian | flip | monitor   (default: all)
 *   optional wallet override: TEST_WALLET=<addr> pnpm exec tsx scripts/test-alerts.ts
 */
import "dotenv/config";
import type { TraderStateTradeHistoryDelta } from "@ellipsis-labs/rise";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { alertSubscriptions, users } from "../src/db/schema/index.js";
import { startAlertWorker, stopAlertWorker } from "../src/jobs/processors/alert.js";
import { redis } from "../src/lib/redis.js";
import { createRule, deleteRule, generateRuleId } from "../src/services/guardian.js";
import {
  type EvalContext,
  evaluateGuardianRules,
} from "../src/workers/evaluators/guardian.js";
import { emitMonitorFills, evaluateMonitorAlerts } from "../src/workers/evaluators/monitor.js";
import { evaluatePositionFlip } from "../src/workers/evaluators/position-flip.js";
import { bustPriceAlertCache, checkPriceAlerts } from "../src/workers/evaluators/price-alert.js";
import { evaluateRiskTier } from "../src/workers/evaluators/risk-tier.js";
import type { AccountSnapshot, CachedPosition, DerivedPosition } from "../src/types/index.js";

const DEFAULT_WALLET = "HiYGtwBa7UwpJf4XnRDkDmKgRi8QgnM3LAfV23Cmjf6h";
const WALLET = process.env.TEST_WALLET ?? DEFAULT_WALLET;
const SCENARIO = (process.argv[2] ?? "all").toLowerCase();

const ENTRY = 83.51;
const MARK = 82.7;
const SIZE_TOKENS = 1.53;
const BASE_LOTS = 153;
const SUB_COLLATERAL = 16.98;
const LIQ = 74.91;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`  ${msg}`);

function cachedSol(): CachedPosition {
  return {
    symbol: "SOL",
    side: "long",
    sizeTokens: SIZE_TOKENS,
    basePositionLots: BASE_LOTS,
    entryPrice: ENTRY,
    subaccountIndex: 0,
    unsettledFundingUsdc: 0,
    hasTp: false,
    hasSl: true,
  };
}

function derivedSol(mark = MARK): DerivedPosition {
  const base = cachedSol();
  const uPnl = (mark - base.entryPrice) * base.sizeTokens + base.unsettledFundingUsdc;
  return { ...base, mark, uPnl, notional: base.sizeTokens * mark };
}

function snapshot(): AccountSnapshot {
  return {
    walletAddress: WALLET,
    collateralBySub: { 0: SUB_COLLATERAL },
    depositedCollateralUsdc: SUB_COLLATERAL,
    positions: [cachedSol()],
    sequenceBySub: { 0: 1 },
    updatedAt: Date.now(),
  };
}

function guardianCtx(
  userId: string,
  telegramId: string,
  rest: EvalContext["rest"],
): EvalContext {
  const derived = derivedSol();
  return {
    userId,
    telegramId,
    walletAddress: WALLET,
    snapshot: snapshot(),
    derived: { positions: [derived], totalExposure: derived.notional },
    rest,
  };
}

async function clearDedup(telegramId: string, userId: string) {
  const keys = [
    ...(await redis.keys(`alert:dedup:${telegramId}:*`)),
    ...(await redis.keys(`ws:dedup:${telegramId}:*`)),
    ...(await redis.keys(`alert:price:${userId}:*`)),
  ];
  if (keys.length > 0) await redis.del(...keys);
}

async function fireGuardianRule(
  userId: string,
  telegramId: string,
  rule: { ruleType: Parameters<typeof createRule>[0]["ruleType"]; threshold: string; direction: string },
  rest: EvalContext["rest"],
) {
  const id = generateRuleId();
  await createRule({
    id,
    userId,
    ruleType: rule.ruleType,
    symbol: null,
    threshold: rule.threshold,
    direction: rule.direction,
    action: "suggest",
  });
  try {
    await clearDedup(telegramId, userId);
    await evaluateGuardianRules(guardianCtx(userId, telegramId, rest));
  } finally {
    await deleteRule(id, userId);
  }
}

interface Target {
  userId: string;
  telegramId: string;
}

// checkPriceAlerts scans EVERY active price subscription against the fed price
// map, so we use a synthetic symbol that no real alert targets — feeding it a
// price only crosses our own test row and never touches the user's real alerts.
const TEST_SYMBOL = "ZZZTEST";

async function runPrice(t: Target) {
  console.log("▶ price alert");
  const id = randomUUID();
  const trigger = MARK - 0.2;
  await db.insert(alertSubscriptions).values({
    id,
    userId: t.userId,
    type: "price",
    symbol: TEST_SYMBOL,
    triggerPrice: String(trigger),
    enabled: true,
  });
  bustPriceAlertCache();
  await clearDedup(t.telegramId, t.userId);

  await checkPriceAlerts(new Map([[TEST_SYMBOL, MARK]]));

  const [after] = await db
    .select()
    .from(alertSubscriptions)
    .where(eq(alertSubscriptions.id, id));
  if (after && after.enabled === false) {
    log(`✓ crossed and queued (row auto-disabled), fed ${MARK} ≥ ${trigger}`);
  } else {
    log(`✗ did NOT fire — row still enabled=${after?.enabled}`);
  }

  await sleep(1500);
  await db.delete(alertSubscriptions).where(eq(alertSubscriptions.id, id));
  bustPriceAlertCache();
}

async function runRisk(t: Target) {
  console.log("▶ risk-tier (liquidatable)");
  await clearDedup(t.telegramId, t.userId);
  await evaluateRiskTier(
    t.telegramId,
    t.userId,
    { riskTier: "liquidatable", effectiveCollateralUsdc: 4.2, liqPriceBySymbol: { SOL: LIQ }, updatedAt: Date.now() },
    [cachedSol()],
  );
  log("injected riskTier=liquidatable → should fire 🚨");
  await sleep(1500);
}

async function runGuardian(t: Target) {
  console.log("▶ guardian · liq_distance < 10% (actual 9.4%)");
  await fireGuardianRule(
    t.userId,
    t.telegramId,
    { ruleType: "liq_distance", threshold: "10", direction: "below" },
    { riskTier: "healthy", effectiveCollateralUsdc: 15.76, liqPriceBySymbol: { SOL: LIQ }, updatedAt: Date.now() },
  );
  await sleep(1500);

  console.log("▶ guardian · exposure_limit > $100 (actual $126.53)");
  await fireGuardianRule(
    t.userId,
    t.telegramId,
    { ruleType: "exposure_limit", threshold: "100", direction: "above" },
    undefined,
  );
  await sleep(1500);

  console.log("▶ guardian · pnl_target below −5% (actual ≈ −7.3% on collateral)");
  await fireGuardianRule(
    t.userId,
    t.telegramId,
    { ruleType: "pnl_target", threshold: "5", direction: "below" },
    undefined,
  );
  await sleep(1500);
}

async function runFlip(t: Target) {
  console.log("▶ position flip (long → short)");
  await clearDedup(t.telegramId, t.userId);
  const prev = [cachedSol()];
  const now = [{ ...cachedSol(), side: "short" as const, basePositionLots: -BASE_LOTS }];
  await evaluatePositionFlip(t.telegramId, t.userId, now, prev);
  log("flipped SOL long → short → should fire 🔄");
  await sleep(1500);
}

async function runMonitor(t: Target) {
  console.log("▶ monitor: open / close / fill (you are the watcher)");
  const watched = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

  await evaluateMonitorAlerts(watched, [t.telegramId], [cachedSol()], []);
  log("watched wallet opened SOL → monitor_open");
  await sleep(1500);

  await evaluateMonitorAlerts(watched, [t.telegramId], [], [cachedSol()]);
  log("watched wallet closed SOL → monitor_close");
  await sleep(1500);

  const fill: TraderStateTradeHistoryDelta = {
    timestamp: Date.now(),
    slot: 0,
    slotIndex: 0,
    instructionIndex: 0,
    eventIndex: 0,
    market: "SOL",
    instructionType: "PlaceMarketOrder",
    tradeType: "market",
    baseQtyBefore: "0",
    baseQtyAfter: "1.0",
    size: "1.0",
    liquidity: "taker",
    price: String(MARK),
    fee: "0.02",
    realizedPnl: "0",
    signature: "TESTSIGNATURExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  emitMonitorFills(watched, [t.telegramId], [fill]);
  log("watched wallet filled SOL → monitor_fill");
  await sleep(1500);
}

async function main() {
  const user = await db.query.users.findFirst({ where: eq(users.walletAddress, WALLET) });
  if (!user) {
    console.error(`No user found for wallet ${WALLET}. Set TEST_WALLET to a registered wallet.`);
    process.exit(1);
  }
  const target: Target = { userId: user.id, telegramId: user.telegramId };
  console.log(`Target: ${WALLET}  telegramId=${target.telegramId}  scenario=${SCENARIO}\n`);

  startAlertWorker();
  await sleep(500);

  if (SCENARIO === "all" || SCENARIO === "price") await runPrice(target);
  if (SCENARIO === "all" || SCENARIO === "risk") await runRisk(target);
  if (SCENARIO === "all" || SCENARIO === "guardian") await runGuardian(target);
  if (SCENARIO === "all" || SCENARIO === "flip") await runFlip(target);
  if (SCENARIO === "all" || SCENARIO === "monitor") await runMonitor(target);

  console.log("\nDone. Check your Telegram for the alerts above.");
  await sleep(1500);
  await stopAlertWorker();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
