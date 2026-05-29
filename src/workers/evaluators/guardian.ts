import { toBotError } from "../../bot/lib/errors.js";
import { solscanUrl } from "../../bot/lib/fmt.js";
import type { GuardianRule } from "../../db/schema/guardian.js";
import { type AlertButton, alertQueue } from "../../jobs/queues.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { getActiveRules, markTriggered } from "../../services/guardian.js";
import { getPositionConditionals } from "../../services/phoenix/conditional.js";
import { getStats } from "../../services/phoenix/market-stats-feed.js";
import {
  addMargin,
  closePosition,
  getFeeConfig,
  setPositionTpSl,
} from "../../services/phoenix/trade.js";
import { getSettings } from "../../services/settings.js";
import type {
  AccountSnapshot,
  DerivedMetrics,
  DerivedPosition,
  RestDerived,
} from "../../types/index.js";
import { esc } from "./shared.js";

interface PeakRecord {
  peakPnl: number;
  ts: number;
}

async function getPeak(userId: string, symbol: string): Promise<PeakRecord | null> {
  const raw = await redis.get(`guardian:peak:${userId}:${symbol}`);
  return raw ? (JSON.parse(raw) as PeakRecord) : null;
}

async function setPeak(userId: string, symbol: string, pnl: number) {
  await redis.set(
    `guardian:peak:${userId}:${symbol}`,
    JSON.stringify({ peakPnl: pnl, ts: Date.now() }),
  );
}

export async function clearPeak(userId: string, symbol: string) {
  await redis.del(`guardian:peak:${userId}:${symbol}`);
}

const TRAIL_STEP_PCT = 0.003;
const TRAIL_MIN_INTERVAL_MS = 20_000;
const BE_BUFFER = 0.001;

interface TrailState {
  peak: number;
  stopPrice: number;
  ts: number;
}

export async function clearTrail(userId: string, symbol: string) {
  await redis.del(
    `guardian:trail:${userId}:${symbol}:long`,
    `guardian:trail:${userId}:${symbol}:short`,
    `guardian:be:${userId}:${symbol}:long`,
    `guardian:be:${userId}:${symbol}:short`,
  );
}

export function isSnoozed(ruleId: string): Promise<boolean> {
  return redis.get(`guardian:snooze:${ruleId}`).then((v) => v !== null);
}

export function dailyFundingPaid(
  side: "long" | "short",
  annualPct: number,
  notional: number,
): number {
  const annual = annualPct / 100;
  return ((side === "long" ? annual : -annual) * notional) / 365;
}

export function computeTrailStop(side: "long" | "short", peak: number, trailPct: number): number {
  const trail = trailPct / 100;
  return side === "long" ? peak * (1 - trail) : peak * (1 + trail);
}

export interface EvalContext {
  userId: string;
  telegramId: string;
  walletAddress: string;
  snapshot: AccountSnapshot;
  derived: DerivedMetrics;
  rest: RestDerived | undefined;
}

export async function evaluateGuardianRules(ctx: EvalContext) {
  const rules = await getActiveRules(ctx.userId);
  if (rules.length === 0) return;

  for (const rule of rules) {
    try {
      if (await isSnoozed(rule.id)) continue;
      if ((await redis.get(`guardian:retry:${rule.id}`)) !== null) continue;
      if (rule.lastTriggeredAt) {
        const elapsed = Date.now() - rule.lastTriggeredAt.getTime();
        if (elapsed < rule.cooldownSec * 1000) continue;
      }

      if (rule.ruleType === "trailing_stop") {
        void handleTrailingStop(rule, ctx).catch((err) =>
          logger.error({ err, ruleId: rule.id }, "trailing stop failed"),
        );
        continue;
      }
      if (rule.ruleType === "breakeven") {
        void handleBreakeven(rule, ctx).catch((err) =>
          logger.error({ err, ruleId: rule.id }, "breakeven failed"),
        );
        continue;
      }

      const allPositions = ctx.derived.positions;
      const positions = rule.symbol
        ? allPositions.filter((p) => p.symbol === rule.symbol)
        : allPositions;

      if (
        positions.length === 0 &&
        rule.ruleType !== "exposure_limit" &&
        rule.ruleType !== "margin_ratio"
      ) {
        continue;
      }

      const result = await checkRule(rule, positions, ctx);
      if (!result) continue;

      const isAuto =
        rule.action === "auto_close" ||
        rule.action === "auto_reduce" ||
        rule.action === "auto_margin";

      if (isAuto) {
        void executeAutoAction(rule, result.triggerPosition, ctx).catch((err) =>
          logger.error({ err, ruleId: rule.id }, "auto action failed"),
        );
      } else {
        await markTriggered(rule.id, ctx.userId);
        await queueGuardianAlert(rule, result, ctx);
      }
    } catch (err) {
      logger.error({ err, ruleId: rule.id }, "Guardian rule evaluation failed");
    }
  }
}

function findRulePosition(rule: GuardianRule, ctx: EvalContext): DerivedPosition | null {
  if (!rule.symbol) return null;
  const pos = ctx.derived.positions.find((p) => p.symbol === rule.symbol);
  if (!pos) return null;
  if (rule.side && rule.side !== pos.side) return null;
  return pos;
}

async function setStopLoss(
  ctx: EvalContext,
  pos: DerivedPosition,
  stopPrice: number,
): Promise<void> {
  const rungs = await getPositionConditionals(ctx.walletAddress, pos.symbol, pos.side);
  const cancelSlIndices = rungs.filter((r) => r.leg === "sl").map((r) => r.conditionalOrderIndex);
  const settings = await getSettings(ctx.userId);
  const fee = getFeeConfig(settings.feeMode, settings.customFeeSol);
  await setPositionTpSl(
    {
      symbol: pos.symbol,
      walletAddress: ctx.walletAddress,
      positionSide: pos.side,
      cancelSlIndices,
      sl: [{ leg: "sl", triggerPrice: stopPrice, mode: "market", size: { kind: "full" } }],
    },
    fee,
  );
}

async function handleTrailingStop(rule: GuardianRule, ctx: EvalContext): Promise<void> {
  const pos = findRulePosition(rule, ctx);
  if (!pos) return;
  const trail = Number(rule.threshold) / 100;
  if (!(trail > 0)) return;
  const mark = pos.mark;
  if (!(mark > 0)) return;

  const key = `guardian:trail:${ctx.userId}:${pos.symbol}:${pos.side}`;
  const raw = await redis.get(key);
  const state = raw ? (JSON.parse(raw) as TrailState) : null;

  const peak = state
    ? pos.side === "long"
      ? Math.max(state.peak, mark)
      : Math.min(state.peak, mark)
    : mark;
  const wantStop = computeTrailStop(pos.side, peak, Number(rule.threshold));

  const improves =
    !state ||
    (pos.side === "long"
      ? wantStop > state.stopPrice * (1 + TRAIL_STEP_PCT)
      : wantStop < state.stopPrice * (1 - TRAIL_STEP_PCT));
  const cooled = !state || Date.now() - state.ts > TRAIL_MIN_INTERVAL_MS;

  if (!improves || !cooled) {
    if (state && peak !== state.peak) {
      const next: TrailState = { peak, stopPrice: state.stopPrice, ts: state.ts };
      await redis.set(key, JSON.stringify(next));
    }
    return;
  }

  await setStopLoss(ctx, pos, wantStop);
  const next: TrailState = { peak, stopPrice: wantStop, ts: Date.now() };
  await redis.set(key, JSON.stringify(next));

  await alertQueue.add("guardian-trail", {
    telegramId: ctx.telegramId,
    type: "guardian",
    symbol: pos.symbol,
    message: [
      "🛟 <b>Trailing stop moved</b>",
      "",
      `${esc(pos.symbol)} ${esc(pos.side.toUpperCase())} — stop now <code>$${wantStop.toFixed(4)}</code>`,
    ].join("\n"),
  });
}

async function handleBreakeven(rule: GuardianRule, ctx: EvalContext): Promise<void> {
  const pos = findRulePosition(rule, ctx);
  if (!pos) return;
  const key = `guardian:be:${ctx.userId}:${pos.symbol}:${pos.side}`;
  if ((await redis.get(key)) !== null) return;

  const margin = ctx.rest?.marginBySymbol[pos.symbol];
  if (!margin || margin <= 0) return;
  const pnlPct = (pos.uPnl / margin) * 100;
  if (pnlPct < Number(rule.threshold)) return;

  const stop =
    pos.side === "long" ? pos.entryPrice * (1 + BE_BUFFER) : pos.entryPrice * (1 - BE_BUFFER);
  await setStopLoss(ctx, pos, stop);
  await redis.set(key, "1");

  await alertQueue.add("guardian-breakeven", {
    telegramId: ctx.telegramId,
    type: "guardian",
    symbol: pos.symbol,
    message: [
      "🎯 <b>Stop moved to breakeven</b>",
      "",
      `${esc(pos.symbol)} ${esc(pos.side.toUpperCase())} — stop now <code>$${stop.toFixed(4)}</code>`,
    ].join("\n"),
  });
}

interface CheckResult {
  triggerPosition: DerivedPosition | null;
  detail: string;
}

function marginForPosition(pos: DerivedPosition, snapshot: AccountSnapshot): number {
  return snapshot.collateralBySub[pos.subaccountIndex] ?? snapshot.depositedCollateralUsdc;
}

async function checkRule(
  rule: GuardianRule,
  positions: DerivedPosition[],
  ctx: EvalContext,
): Promise<CheckResult | null> {
  const threshold = Number(rule.threshold);

  switch (rule.ruleType) {
    case "liq_distance": {
      if (!ctx.rest) return null;
      for (const pos of positions) {
        const liq = ctx.rest.liqPriceBySymbol[pos.symbol] ?? 0;
        if (liq <= 0 || pos.mark <= 0) continue;
        const dist = (Math.abs(pos.mark - liq) / pos.mark) * 100;
        if (dist < threshold) {
          return {
            triggerPosition: pos,
            detail: `Liq distance: ${dist.toFixed(1)}% (threshold: ${threshold}%)`,
          };
        }
      }
      return null;
    }

    case "drawdown": {
      for (const pos of positions) {
        const currentPnl = pos.uPnl;
        const peak = await getPeak(ctx.userId, pos.symbol);

        if (!peak || currentPnl > peak.peakPnl) {
          await setPeak(ctx.userId, pos.symbol, currentPnl);
          continue;
        }

        if (peak.peakPnl <= 0) continue;
        const drawdownPct = ((peak.peakPnl - currentPnl) / peak.peakPnl) * 100;
        if (drawdownPct >= threshold) {
          const drop = peak.peakPnl - currentPnl;
          const peakAgo = timeSince(peak.ts);
          return {
            triggerPosition: pos,
            detail: `Peak: +$${peak.peakPnl.toFixed(2)} (${peakAgo})\nCurrent: ${currentPnl >= 0 ? "+" : ""}$${currentPnl.toFixed(2)}\nDrop: −$${drop.toFixed(2)}`,
          };
        }
      }
      return null;
    }

    case "pnl_target": {
      for (const pos of positions) {
        const margin = ctx.rest?.marginBySymbol[pos.symbol] ?? marginForPosition(pos, ctx.snapshot);
        if (margin <= 0) continue;
        const pnlPct = (pos.uPnl / margin) * 100;
        if (rule.direction === "above" && pnlPct >= threshold) {
          return {
            triggerPosition: pos,
            detail: `PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (target: +${threshold}%)`,
          };
        }
        if (rule.direction === "below" && pnlPct <= -threshold) {
          return {
            triggerPosition: pos,
            detail: `PnL: ${pnlPct.toFixed(1)}% (limit: −${threshold}%)`,
          };
        }
      }
      return null;
    }

    case "funding_drain": {
      for (const pos of positions) {
        const stats = getStats(pos.symbol);
        if (!stats) continue;
        const dailyPaid = dailyFundingPaid(pos.side, stats.fundingAnnualPct, pos.notional);
        if (dailyPaid >= threshold) {
          return {
            triggerPosition: pos,
            detail: `Daily funding paid: $${dailyPaid.toFixed(2)} (limit: $${threshold})`,
          };
        }
      }
      return null;
    }

    case "exposure_limit": {
      const totalNotional = ctx.derived.totalExposure;
      if (totalNotional >= threshold) {
        return {
          triggerPosition: ctx.derived.positions[0] ?? null,
          detail: `Total exposure: $${totalNotional.toFixed(2)} (limit: $${threshold})`,
        };
      }
      return null;
    }

    case "margin_ratio": {
      if (!ctx.rest) return null;
      const totalExposure = ctx.derived.totalExposure;
      if (totalExposure === 0) return null;
      const ratio = (ctx.rest.effectiveCollateralUsdc / totalExposure) * 100;
      if (ratio < threshold) {
        return {
          triggerPosition: ctx.derived.positions[0] ?? null,
          detail: `Margin ratio: ${ratio.toFixed(1)}% (min: ${threshold}%)`,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

function timeSince(tsMs: number): string {
  const diff = Math.floor((Date.now() - tsMs) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const RULE_TYPE_LABELS: Record<string, string> = {
  liq_distance: "⚡ Liq distance",
  drawdown: "📉 Drawdown",
  pnl_target: "🎯 PnL target",
  funding_drain: "💸 Funding cost",
  exposure_limit: "📊 Exposure limit",
  margin_ratio: "📊 Margin ratio",
};

function ruleLabel(rule: GuardianRule): string {
  return RULE_TYPE_LABELS[rule.ruleType] ?? rule.ruleType;
}

async function queueGuardianAlert(rule: GuardianRule, result: CheckResult, ctx: EvalContext) {
  const pos = result.triggerPosition;
  const symbolPart = pos ? `${esc(pos.symbol)} ${esc(pos.side.toUpperCase())}` : "account";
  const header = `🛡 <b>RISK GUARDIAN</b>\n\n${ruleLabel(rule)} — ${symbolPart}`;

  const lines = [header, "", result.detail];

  const keyboard: AlertButton[][] = [];

  if (rule.action === "suggest" && pos) {
    keyboard.push([
      { text: `🔴 Close ${pos.symbol}`, callback_data: `grd:close:${pos.symbol}:${pos.side}` },
      { text: "🟡 Reduce 50%", callback_data: `grd:reduce:${pos.symbol}:${pos.side}:50` },
    ]);
    keyboard.push([
      { text: "📥 Add $100", callback_data: `grd:margin:${pos.symbol}:100` },
      { text: "⏸ Snooze 30m", callback_data: `grd:snooze:${rule.id}:30` },
    ]);
  }

  keyboard.push([{ text: "📊 View position", callback_data: "nav:positions" }]);

  await alertQueue.add("guardian-alert", {
    telegramId: ctx.telegramId,
    type: "guardian",
    symbol: pos?.symbol,
    message: lines.join("\n"),
    keyboard,
  });
}

async function executeAutoAction(
  rule: GuardianRule,
  triggerPosition: DerivedPosition | null,
  ctx: EvalContext,
) {
  const lockKey = `guardian:auto:lock:${ctx.userId}`;
  const locked = await redis.set(lockKey, "1", "EX", 150, "NX");
  if (!locked) return;

  try {
    const settings = await getSettings(ctx.userId);
    const fee = getFeeConfig(settings.feeMode, settings.customFeeSol);
    let txSig: string | undefined;
    let actionDesc = "";

    if (rule.action === "auto_close" && triggerPosition) {
      actionDesc = `Closed 100% of ${triggerPosition.symbol} ${triggerPosition.side.toUpperCase()}`;
      txSig = await closePosition(triggerPosition.symbol, ctx.walletAddress, 1, fee);
    } else if (rule.action === "auto_reduce" && triggerPosition) {
      const fraction = Number(rule.actionParam ?? 50) / 100;
      actionDesc = `Reduced ${Math.round(fraction * 100)}% of ${triggerPosition.symbol} ${triggerPosition.side.toUpperCase()}`;
      txSig = await closePosition(triggerPosition.symbol, ctx.walletAddress, fraction, fee);
    } else if (rule.action === "auto_margin") {
      const amountStr = String(rule.actionParam ?? 100);
      const amount = Number(amountStr);
      const symbolLabel = triggerPosition?.symbol ?? "account";
      actionDesc = `Added $${amount} margin to ${symbolLabel}`;
      txSig = await addMargin(symbolLabel, ctx.walletAddress, amountStr, fee);
    } else {
      return;
    }

    await markTriggered(rule.id, ctx.userId);

    const txLine = txSig ? `Tx: <a href="${solscanUrl(txSig)}">${txSig.slice(0, 8)}…</a>` : "";

    await alertQueue.add("guardian-auto-receipt", {
      telegramId: ctx.telegramId,
      type: "guardian",
      symbol: triggerPosition?.symbol,
      message: [
        "🛡 <b>AUTO-PROTECTION EXECUTED</b>",
        "",
        `${ruleLabel(rule)} triggered`,
        "",
        `Action: ${esc(actionDesc)}`,
        txLine,
        "",
        "Disable anytime: /guardian off",
      ]
        .filter(Boolean)
        .join("\n"),
      keyboard: [
        [
          { text: "📊 Positions", callback_data: "nav:positions" },
          { text: "🛡 Guardian", callback_data: "grd:list" },
        ],
      ],
    });
  } catch (err) {
    const be = toBotError(err);
    await redis.set(`guardian:retry:${rule.id}`, "1", "EX", 30, "NX");
    const pos = triggerPosition;
    const keyboard: AlertButton[][] = [];
    if (pos) {
      keyboard.push([
        {
          text: `🔴 Close ${pos.symbol} now`,
          callback_data: `grd:close:${pos.symbol}:${pos.side}`,
        },
        { text: "📊 View position", callback_data: "nav:positions" },
      ]);
    }
    keyboard.push([{ text: "🛡 Guardian", callback_data: "grd:list" }]);

    await alertQueue
      .add("guardian-auto-fail", {
        telegramId: ctx.telegramId,
        type: "guardian",
        symbol: pos?.symbol,
        message: [
          "🛡 <b>AUTO-PROTECTION FAILED</b>",
          "",
          `${ruleLabel(rule)} triggered`,
          "",
          `❌ ${esc(be.userMessage)}`,
          be.retryable ? "↩️ Safe to retry manually." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        keyboard,
      })
      .catch(() => undefined);
  } finally {
    await redis.del(lockKey);
  }
}
