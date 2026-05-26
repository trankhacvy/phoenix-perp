import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import {
  type ConditionalRung,
  type ExecMode,
  type Leg,
  type RungInput,
  type RungSize,
  resolveSize,
  validateTriggerPrice,
} from "../../services/phoenix/conditional.js";
import { getPositionConditionals } from "../../services/phoenix/conditional.js";
import { getMarket } from "../../services/phoenix/market.js";
import { getTraderState } from "../../services/phoenix/position.js";
import {
  cancelAllPositionConditionals,
  cancelPositionConditional,
  getFeeConfig,
  setPositionTpSl,
} from "../../services/phoenix/trade.js";
import { getSettings } from "../../services/settings.js";
import type { BotContext, PhoenixPosition } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";
import { toBotError } from "../lib/errors.js";
import { price as fmtPrice, parseAmount, pct, signedUsd, usd } from "../lib/fmt.js";
import { claimIdempotencyKey } from "../lib/idempotent.js";
import { clearPending, setPending } from "../lib/pending.js";
import { checkOrderRateLimit } from "../middleware/rate-limit.js";

// ── Constants ───────────────────────────────────────────────────────────────

const PRESET_PCTS_TP = [5, 10, 20, 30, 50] as const;
const PRESET_PCTS_SL = [2, 5, 10, 15] as const;
const PRESET_SIZE_PCTS = [25, 50, 75, 100] as const;
const TRADE_LOCK_TTL = 150;

// ── Callback / encoding helpers ─────────────────────────────────────────────

function priceForCb(p: number): string {
  return p.toFixed(8).replace(/\.?0+$/, "");
}

function legLabel(leg: Leg): string {
  return leg === "tp" ? "Take Profit" : "Stop Loss";
}

function legEmoji(leg: Leg): string {
  return leg === "tp" ? "🎯" : "🛑";
}

function defaultMode(leg: Leg): ExecMode {
  return leg === "tp" ? "limit" : "market";
}

function isGreaterDir(leg: Leg, side: "long" | "short"): boolean {
  return (leg === "tp" && side === "long") || (leg === "sl" && side === "short");
}

function presetPctsFor(leg: Leg): readonly number[] {
  return leg === "tp" ? PRESET_PCTS_TP : PRESET_PCTS_SL;
}

function pctToTriggerPrice(
  leg: Leg,
  side: "long" | "short",
  mark: number,
  presetPct: number,
): number {
  const greater = isGreaterDir(leg, side);
  const delta = presetPct / 100;
  return greater ? mark * (1 + delta) : mark * (1 - delta);
}

function shortSym(s: string): string {
  return s.toUpperCase();
}

function estimatePnl(
  triggerPrice: number,
  entryPrice: number,
  side: "long" | "short",
  sizeLots: bigint,
  baseLotsDecimals: number,
): number {
  const tokens = Number(sizeLots) * 10 ** -baseLotsDecimals;
  return side === "long"
    ? (triggerPrice - entryPrice) * tokens
    : (entryPrice - triggerPrice) * tokens;
}

// ── Data fetch helper ───────────────────────────────────────────────────────

interface PositionCtx {
  pos: PhoenixPosition;
  rungs: ConditionalRung[];
  market: { tickSize: number; baseLotsDecimals: number; assetId: number };
  positionLots: bigint;
  allocatedLots: { tp: bigint; sl: bigint };
  remainingLots: { tp: bigint; sl: bigint };
}

async function loadPositionCtx(
  walletAddress: string,
  symbol: string,
  side: "long" | "short",
): Promise<PositionCtx | null> {
  const [state, rungs, market] = await Promise.all([
    getTraderState(walletAddress),
    getPositionConditionals(walletAddress, symbol, side).catch(() => [] as ConditionalRung[]),
    getMarket(symbol),
  ]);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);
  if (!pos) return null;

  const sizeTokens = Number(pos.size);
  const factor = 10 ** market.baseLotsDecimals;
  const positionLots = BigInt(Math.round(sizeTokens * factor));

  const tpAlloc = rungs
    .filter((r) => r.leg === "tp")
    .reduce<bigint>((s, r) => s + r.maxSizeLots, 0n);
  const slAlloc = rungs
    .filter((r) => r.leg === "sl")
    .reduce<bigint>((s, r) => s + r.maxSizeLots, 0n);

  return {
    pos,
    rungs,
    market: {
      tickSize: market.tickSize,
      baseLotsDecimals: market.baseLotsDecimals,
      assetId: market.assetId,
    },
    positionLots,
    allocatedLots: { tp: tpAlloc, sl: slAlloc },
    remainingLots: {
      tp: positionLots > tpAlloc ? positionLots - tpAlloc : 0n,
      sl: positionLots > slAlloc ? positionLots - slAlloc : 0n,
    },
  };
}

// ── Position-gone helper ────────────────────────────────────────────────────

async function sendPositionGone(ctx: BotContext, edit: boolean, msg: string): Promise<void> {
  const kb = new InlineKeyboard().text("📊 Positions", "nav:positions");
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg, { reply_markup: kb });
  } else {
    await ctx.reply(msg, { reply_markup: kb });
  }
}

// ── Manager screen ──────────────────────────────────────────────────────────

const CIRCLE_NUMS_MGR = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
function circleNum(i: number): string {
  return CIRCLE_NUMS_MGR[i] ?? `${i + 1}.`;
}

function liqDistanceDot(distancePct: number): string {
  if (distancePct >= 15) return "🟢";
  if (distancePct >= 5) return "🟡";
  return "🔴";
}

function marginOf(pos: PhoenixPosition): number {
  const size = Number(pos.size);
  const entry = Number(pos.entryPrice);
  const lev = pos.leverage && pos.leverage > 0 ? pos.leverage : 1;
  return (entry * size) / lev;
}

function marginMultLabel(amount: number, margin: number): string {
  if (margin <= 0) return "";
  const mult = amount / margin;
  const sign = mult >= 0 ? "+" : "";
  return ` (${sign}${mult.toFixed(2)}× margin)`;
}

function formatRungBlock(
  rung: ConditionalRung,
  i: number,
  entryPrice: number,
  side: "long" | "short",
  baseLotsDecimals: number,
  positionLots: bigint,
  margin: number,
  symbol: string,
): FormattedString {
  const pctFromEntry =
    entryPrice > 0
      ? side === "long"
        ? ((rung.triggerPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - rung.triggerPrice) / entryPrice) * 100
      : 0;
  const sizeTokens = Number(rung.maxSizeLots) * 10 ** -baseLotsDecimals;
  const sizePctOfPos =
    positionLots > 0n ? (Number(rung.maxSizeLots) / Number(positionLots)) * 100 : 0;
  const estPnl = estimatePnl(
    rung.triggerPrice,
    entryPrice,
    side,
    rung.maxSizeLots,
    baseLotsDecimals,
  );
  const sizeStr = sizeTokens.toFixed(Math.min(4, baseLotsDecimals));
  const multStr = marginMultLabel(estPnl, margin);
  return fmt`  ${circleNum(i)} ${FormattedString.b(fmtPrice(rung.triggerPrice))}  ${pct(pctFromEntry)}  ·  ${FormattedString.i(rung.mode)}
     close ${FormattedString.b(`${sizeStr} ${symbol}`)} (${sizePctOfPos.toFixed(0)}%)  →  est ${FormattedString.b(signedUsd(estPnl))}${FormattedString.i(multStr)}`;
}

function buildManagerHeader(
  ctxData: PositionCtx,
  leg: Leg,
  showSubtitle: boolean,
): FormattedString {
  const { pos } = ctxData;
  const mark = Number(pos.markPrice);
  const entry = Number(pos.entryPrice);
  const sideLabel = pos.side === "long" ? "LONG" : "SHORT";
  const moveFromEntry = entry > 0 ? ((mark - entry) / entry) * 100 : 0;
  const margin = marginOf(pos);
  const liq = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);

  const subtitle = showSubtitle
    ? fmt`\n${FormattedString.i("Set up to 8 levels — ladder out at multiple prices.")}`
    : fmt``;

  // SL screen gets liq line; TP screen skips it (less relevant for profit-taking)
  let liqLine = fmt``;
  if (leg === "sl" && liq > 0 && mark > 0) {
    const distRaw = pos.side === "long" ? ((mark - liq) / mark) * 100 : ((liq - mark) / mark) * 100;
    const dist = Math.max(0, distRaw);
    liqLine = fmt`
Liq        ${FormattedString.b(fmtPrice(liq))}  ·  ${FormattedString.b(`${dist.toFixed(1)}% away`)} ${liqDistanceDot(dist)}`;
  }

  return fmt`${legEmoji(leg)} ${FormattedString.b(`${pos.symbol} ${sideLabel} · ${legLabel(leg)}`)}${subtitle}
━━━━━━━━━━━━━━━━━━━━━━━━━
Margin     ${FormattedString.b(usd(margin))}
Mark       ${FormattedString.b(fmtPrice(mark))}  ${FormattedString.i(`(${pct(moveFromEntry)} vs entry ${fmtPrice(entry)})`)}${liqLine}`;
}

function crossLegFooter(ctxData: PositionCtx, currentLeg: Leg): FormattedString {
  const otherLeg: Leg = currentLeg === "tp" ? "sl" : "tp";
  const otherRungs = ctxData.rungs.filter((r) => r.leg === otherLeg);
  const emoji = otherLeg === "tp" ? "🎯" : "🛑";
  const name = otherLeg === "tp" ? "TP" : "SL";

  if (otherRungs.length === 0) {
    const warning = otherLeg === "sl" ? "  ⚠️ unprotected" : "";
    return fmt`${emoji} ${name}: ${FormattedString.i("not set")}${warning}`;
  }

  const totalLots = otherRungs.reduce<bigint>((s, r) => s + r.maxSizeLots, 0n);
  const pctCov =
    ctxData.positionLots > 0n ? Number((totalLots * 10000n) / ctxData.positionLots) / 100 : 0;
  const fullyCovered = pctCov >= 99.5;
  const tag = fullyCovered ? "✅" : "⚠️";
  const summary =
    otherRungs.length === 1
      ? `${fmtPrice(otherRungs[0].triggerPrice)} covering ${pctCov.toFixed(0)}%`
      : `${otherRungs.length} rungs covering ${pctCov.toFixed(0)}%`;
  return fmt`${emoji} ${name}: ${summary}  ${tag}`;
}

function buildEmptyManagerKb(
  leg: Leg,
  side: "long" | "short",
  symbol: string,
  mark: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const pcts = presetPctsFor(leg);
  let i = 0;
  for (const presetPct of pcts) {
    const trigger = pctToTriggerPrice(leg, side, mark, presetPct);
    const sign = isGreaterDir(leg, side) ? "+" : "-";
    kb.text(
      `${sign}${presetPct}%  ${fmtPrice(trigger)}`,
      `tpsl:px:${leg}:${symbol}:${side}:${presetPct}`,
    );
    i++;
    if (i % 2 === 0) kb.row();
  }
  if (i % 2 === 1) kb.row();
  kb.text("✏️ Custom price", `tpsl:pxc:${leg}:${symbol}:${side}`).row();
  kb.text("← Back", `pos:detail:${symbol}:${side}`);
  return kb;
}

function buildPopulatedManagerKb(
  leg: Leg,
  side: "long" | "short",
  symbol: string,
  rungs: ConditionalRung[],
  remainingLots: bigint,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < rungs.length; i++) {
    const r = rungs[i];
    kb.text(`✏️ Edit #${i + 1}`, `tpsl:row:${leg}:${symbol}:${side}:${r.conditionalOrderIndex}`);
    if (i % 2 === 1) kb.row();
  }
  if (rungs.length % 2 === 1) kb.row();

  if (remainingLots > 0n) {
    kb.text("+ Add level", `tpsl:add:${leg}:${symbol}:${side}`);
  } else if (rungs.length === 1) {
    // FIX 3: at 100% with single rung → offer split-into-ladder shortcut
    kb.text("🪜 Split into ladder", `tpsl:split:${leg}:${symbol}:${side}`);
  }
  kb.text("🗑 Clear all", `tpsl:clr:${leg}:${symbol}:${side}`).row();
  kb.text("← Back", `pos:detail:${symbol}:${side}`);
  return kb;
}

export async function sendTpSlManager(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  edit = false,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(
      ctx,
      edit,
      `No open ${symbol} ${side} position. It may have been closed.`,
    );
    return;
  }

  const legRungs = data.rungs.filter((r) => r.leg === leg);
  const isEmpty = legRungs.length === 0;
  const header = buildManagerHeader(data, leg, isEmpty);

  const entry = Number(data.pos.entryPrice);
  const margin = marginOf(data.pos);
  const allocated = leg === "tp" ? data.allocatedLots.tp : data.allocatedLots.sl;
  const allocPct =
    data.positionLots > 0n ? Number((allocated * 10000n) / data.positionLots) / 100 : 0;
  const fullyCovered = allocPct >= 99.5;

  let body: FormattedString;
  let kb: InlineKeyboard;
  if (isEmpty) {
    body = fmt`${FormattedString.i(`No ${legLabel(leg).toLowerCase()} set.`)}

Pick a trigger — next step lets you choose ${FormattedString.b("how much")} of the position to close (you can add more levels after):`;
    kb = buildEmptyManagerKb(leg, side, symbol, Number(data.pos.markPrice));
  } else {
    const rungBlocks = legRungs.map((r, i) =>
      formatRungBlock(
        r,
        i,
        entry,
        side,
        data.market.baseLotsDecimals,
        data.positionLots,
        margin,
        symbol,
      ),
    );

    // Coverage headline
    let coverageHeadline: FormattedString;
    if (leg === "tp") {
      const ok = fullyCovered ? "✅" : "";
      coverageHeadline = fmt`${FormattedString.b(`Ladder (${legRungs.length} ${legRungs.length === 1 ? "rung" : "rungs"})`)} — ${allocPct.toFixed(0)}% covered ${ok}`;
    } else {
      // SL — partial coverage is SAFETY ISSUE, must shout
      coverageHeadline = fullyCovered
        ? fmt`${FormattedString.b(`Stops (${legRungs.length} ${legRungs.length === 1 ? "rung" : "rungs"})`)} — 100% protected ✅`
        : fmt`⚠️ ${FormattedString.b(`Stops cover only ${allocPct.toFixed(0)}% of position`)}`;
    }

    // Per-leg totals
    const totals = legRungs.reduce<{ pnl: number }>(
      (acc, r) => ({
        pnl:
          acc.pnl +
          estimatePnl(r.triggerPrice, entry, side, r.maxSizeLots, data.market.baseLotsDecimals),
      }),
      { pnl: 0 },
    );

    let totalsLine: FormattedString;
    if (leg === "tp") {
      if (legRungs.length > 1) {
        totalsLine = fmt`\n  ─────
  ${FormattedString.b(`If all fill:  ${signedUsd(totals.pnl)}`)}${FormattedString.i(marginMultLabel(totals.pnl, margin))} ${totals.pnl > 0 ? "🟢" : "🔴"}`;
      } else {
        totalsLine = fmt``;
      }
    } else {
      // SL — always show max-loss summary and unprotected callout if partial
      const unprotectedLine = fullyCovered
        ? fmt``
        : fmt`\n  ${FormattedString.i(`‼️ ${(100 - allocPct).toFixed(0)}% of position stays exposed past this level`)}`;
      totalsLine = fmt`\n  ─────
  ${FormattedString.b(`Max loss if filled:  ${signedUsd(totals.pnl)}`)}${FormattedString.i(marginMultLabel(totals.pnl, margin))}${unprotectedLine}`;
    }

    body = FormattedString.join([coverageHeadline, fmt``, ...rungBlocks, totalsLine], "\n");
    kb = buildPopulatedManagerKb(
      leg,
      side,
      symbol,
      legRungs,
      leg === "tp" ? data.remainingLots.tp : data.remainingLots.sl,
    );
  }

  // Cross-leg footer — show the other leg's state for context
  const footer = fmt`──────────────────────────
${crossLegFooter(data, leg)}`;

  const msg = FormattedString.join([header, fmt``, body, fmt``, footer], "\n");
  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(msg.text, opts);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes("message is not modified")) throw err;
    }
  } else {
    await ctx.reply(msg.text, opts);
  }
}

// ── Add-rung wizard: price step ─────────────────────────────────────────────

async function sendPriceStep(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  edit = true,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, edit, `No open ${symbol} ${side} position.`);
    return;
  }
  const mark = Number(data.pos.markPrice);

  const kb = new InlineKeyboard();
  const pcts = presetPctsFor(leg);
  let i = 0;
  for (const p of pcts) {
    const trigger = pctToTriggerPrice(leg, side, mark, p);
    const sign = isGreaterDir(leg, side) ? "+" : "-";
    kb.text(`${sign}${p}%  ${fmtPrice(trigger)}`, `tpsl:px2:${leg}:${symbol}:${side}:${p}`);
    i++;
    if (i % 2 === 0) kb.row();
  }
  if (i % 2 === 1) kb.row();
  kb.text("✏️ Custom price", `tpsl:pxc:${leg}:${symbol}:${side}`).row();
  kb.text("← Back", `tpsl:open:${leg}:${symbol}:${side}`);

  const msg = fmt`${legEmoji(leg)} ${FormattedString.b(`Add ${legLabel(leg)} level — ${symbol}`)}
Entry ${FormattedString.b(fmtPrice(Number(data.pos.entryPrice)))} · Mark ${FormattedString.b(fmtPrice(mark))}

Pick trigger price:`;

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

// ── Add-rung wizard: size step ──────────────────────────────────────────────

async function sendSizeStep(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  priceStr: string,
  edit = true,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, edit, `No open ${symbol} ${side} position.`);
    return;
  }
  const triggerPrice = Number(priceStr);
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    await ctx.answerCallbackQuery?.("Invalid price.");
    return;
  }

  const remaining = leg === "tp" ? data.remainingLots.tp : data.remainingLots.sl;
  if (remaining <= 0n) {
    await sendPositionGone(
      ctx,
      edit,
      "No remaining size to allocate. Remove or edit existing levels first.",
    );
    return;
  }

  const remainingTokens = Number(remaining) * 10 ** -data.market.baseLotsDecimals;
  const allocated = leg === "tp" ? data.allocatedLots.tp : data.allocatedLots.sl;
  const allocPct = data.positionLots > 0n ? Number((allocated * 100n) / data.positionLots) : 0;

  const kb = new InlineKeyboard();
  let i = 0;
  for (const p of PRESET_SIZE_PCTS) {
    const lots = (remaining * BigInt(p)) / 100n;
    if (lots <= 0n) continue;
    const tokens = Number(lots) * 10 ** -data.market.baseLotsDecimals;
    const label = p === 100 ? "Full rest" : `${p}%`;
    kb.text(
      `${label}  ${tokens.toFixed(Math.min(4, data.market.baseLotsDecimals))}`,
      `tpsl:sz:${leg}:${symbol}:${side}:${priceStr}:${p}`,
    );
    i++;
    if (i % 2 === 0) kb.row();
  }
  if (i % 2 === 1) kb.row();
  kb.text("✏️ Custom tokens", `tpsl:szc:${leg}:${symbol}:${side}:${priceStr}`).row();
  kb.text("← Back", `tpsl:add:${leg}:${symbol}:${side}`);

  const pctFromMark =
    Number(data.pos.markPrice) > 0
      ? ((triggerPrice - Number(data.pos.markPrice)) / Number(data.pos.markPrice)) * 100
      : 0;

  const msg = fmt`Trigger ${FormattedString.b(fmtPrice(triggerPrice))}  (${pct(pctFromMark)} from mark)
Remaining unallocated: ${FormattedString.b(`${remainingTokens.toFixed(Math.min(4, data.market.baseLotsDecimals))} (${100 - allocPct}%)`)}

How much to close here?`;

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

// ── Confirm step ────────────────────────────────────────────────────────────

async function sendConfirmStep(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  priceStr: string,
  lotsStr: string,
  mode: ExecMode,
  edit = true,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, edit, `No open ${symbol} ${side} position.`);
    return;
  }
  const triggerPrice = Number(priceStr);
  const sizeLots = (() => {
    try {
      return BigInt(lotsStr);
    } catch {
      return 0n;
    }
  })();
  if (sizeLots <= 0n) {
    await ctx.answerCallbackQuery?.("Invalid size.");
    return;
  }

  try {
    validateTriggerPrice(triggerPrice, leg, side, {
      markPrice: data.pos.markPrice,
      liquidationPrice: data.pos.liquidationPrice,
    });
  } catch (err) {
    const be = toBotError(err);
    const errMsg = fmt`⚠️ ${FormattedString.b("Price became invalid")}\n\n${be.userMessage}\n\nPrice may have moved. Start over.`;
    const kb = new InlineKeyboard()
      .text("← Back to manager", `tpsl:open:${leg}:${symbol}:${side}`)
      .text("✕ Cancel", "cancel");
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(errMsg.text, { entities: errMsg.entities, reply_markup: kb });
    } else {
      await ctx.reply(errMsg.text, { entities: errMsg.entities, reply_markup: kb });
    }
    return;
  }

  const remaining = leg === "tp" ? data.remainingLots.tp : data.remainingLots.sl;
  if (sizeLots > remaining) {
    const errMsg = fmt`⚠️ ${FormattedString.b("Size too large")}\n\nRemaining: ${FormattedString.b(`${Number(remaining) * 10 ** -data.market.baseLotsDecimals}`)} tokens.`;
    const kb = new InlineKeyboard()
      .text("← Back", `tpsl:open:${leg}:${symbol}:${side}`)
      .text("✕ Cancel", "cancel");
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(errMsg.text, { entities: errMsg.entities, reply_markup: kb });
    } else {
      await ctx.reply(errMsg.text, { entities: errMsg.entities, reply_markup: kb });
    }
    return;
  }

  const entry = Number(data.pos.entryPrice);
  const pctFromEntry =
    entry > 0
      ? side === "long"
        ? ((triggerPrice - entry) / entry) * 100
        : ((entry - triggerPrice) / entry) * 100
      : 0;
  const pctFromMark =
    Number(data.pos.markPrice) > 0
      ? ((triggerPrice - Number(data.pos.markPrice)) / Number(data.pos.markPrice)) * 100
      : 0;
  const estPnl = estimatePnl(triggerPrice, entry, side, sizeLots, data.market.baseLotsDecimals);
  const sizeTokens = Number(sizeLots) * 10 ** -data.market.baseLotsDecimals;
  const sizePct =
    data.positionLots > 0n ? Number((sizeLots * 10000n) / data.positionLots) / 100 : 0;

  const limitActive = mode === "limit";
  const limitBtn = `${limitActive ? "★ " : ""}Limit`;
  const marketBtn = `${!limitActive ? "★ " : ""}Market`;

  const kb = new InlineKeyboard()
    .text(limitBtn, `tpsl:md:${leg}:${symbol}:${side}:${priceStr}:${sizeLots}:limit`)
    .text(marketBtn, `tpsl:md:${leg}:${symbol}:${side}:${priceStr}:${sizeLots}:market`)
    .row()
    .text("✅ Submit", `tpsl:go:${leg}:${symbol}:${side}:${priceStr}:${sizeLots}:${mode}`)
    .row()
    .text("← Back", `tpsl:add:${leg}:${symbol}:${side}`)
    .text("✕ Cancel", "cancel");

  const execLabel =
    mode === "limit"
      ? `Order rests at $${fmtPrice(triggerPrice).replace("$", "")} until filled.`
      : `Closes immediately at ${isGreaterDir(leg, side) ? "≥" : "≤"} $${fmtPrice(triggerPrice).replace("$", "")} (IOC, ±10% buffer).`;

  const msg = fmt`${legEmoji(leg)} ${FormattedString.b(`Confirm ${legLabel(leg)} — ${symbol}`)}
━━━━━━━━━━━━━━━━━━━━━━━━━
Trigger     ${FormattedString.b(fmtPrice(triggerPrice))}  (${pct(pctFromEntry)} from entry, ${pct(pctFromMark)} from mark)
Size        ${FormattedString.b(`${sizeTokens.toFixed(Math.min(4, data.market.baseLotsDecimals))} ${symbol}`)}  (${sizePct.toFixed(0)}% of position)
Execution   ${FormattedString.b(mode === "limit" ? "Limit" : "Market (IOC)")}
Est. PnL    ${FormattedString.b(signedUsd(estPnl))}  ${FormattedString.i("(approx, excl. fees)")}

${FormattedString.i(execLabel)}`;

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

// ── Submit (place new rung) ─────────────────────────────────────────────────

async function executeAdd(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  priceStr: string,
  lotsStr: string,
  mode: ExecMode,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  if (!(await checkOrderRateLimit(ctx))) return;
  if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery?.id ?? ""))) return;

  const triggerPrice = Number(priceStr);
  const sizeLots = (() => {
    try {
      return BigInt(lotsStr);
    } catch {
      return 0n;
    }
  })();
  if (sizeLots <= 0n || !Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    await ctx.answerCallbackQuery?.("Invalid input.");
    return;
  }

  const user = ctx.user;
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (!chatId || !msgId) return;
  const api = ctx.api;

  const lockKey = `trade:lock:${user.id}`;
  const locked = await redis.set(lockKey, "1", "EX", TRADE_LOCK_TTL, "NX");
  if (!locked) {
    await ctx.editMessageText("Another trade is in progress. Wait a moment and try again.");
    return;
  }

  await ctx.editMessageText(`⏳ Setting ${legLabel(leg).toLowerCase()}…`);

  void (async () => {
    try {
      const s = await getSettings(user.id);
      const fee = getFeeConfig(s.feeMode, s.customFeeSol);

      // FIX 4: detect first-ever rung of this leg to surface ladder hint
      const preRungs = await getPositionConditionals(user.walletAddress, symbol, side).catch(
        () => [] as ConditionalRung[],
      );
      const isFirstRung = preRungs.filter((r) => r.leg === leg).length === 0;

      const sizeInput: RungSize = { kind: "lots", lots: sizeLots };
      const rung: RungInput = { leg, triggerPrice, mode, size: sizeInput };
      await setPositionTpSl(
        {
          symbol,
          walletAddress: user.walletAddress,
          positionSide: side,
          tp: leg === "tp" ? [rung] : [],
          sl: leg === "sl" ? [rung] : [],
        },
        fee,
      );

      // Post-place state for the hint decision
      const postRungs = await getPositionConditionals(user.walletAddress, symbol, side).catch(
        () => [] as ConditionalRung[],
      );
      const legRungsAfter = postRungs.filter((r) => r.leg === leg);
      const allocated = legRungsAfter.reduce<bigint>((sum, r) => sum + r.maxSizeLots, 0n);
      const data = await loadPositionCtx(user.walletAddress, symbol, side);
      const posLots = data ? data.positionLots : 0n;
      const fullyCovered = posLots > 0n && allocated >= posLots;

      const showLadderHint = isFirstRung && fullyCovered;

      const kbBuilder = new InlineKeyboard();
      if (showLadderHint) {
        kbBuilder.text("🪜 Split into ladder", `tpsl:split:${leg}:${symbol}:${side}`).row();
      }
      kbBuilder
        .text(`${legEmoji(leg)} Manager`, `tpsl:open:${leg}:${symbol}:${side}`)
        .text("📊 Position", `pos:detail:${symbol}:${side}`);

      const hintLine = showLadderHint
        ? fmt`\n\n💡 ${FormattedString.i("Tip: want to lock profits at multiple prices? Tap Split into ladder.")}`
        : fmt``;
      const okMsg = fmt`✅ ${FormattedString.b(`${legLabel(leg)} set`)}\n\n${symbol} — ${fmtPrice(triggerPrice)} (${mode}).${hintLine}`;
      await api.editMessageText(chatId, msgId, okMsg.text, {
        entities: okMsg.entities,
        reply_markup: kbBuilder,
      });
    } catch (err) {
      logger.error({ err, symbol, leg }, "tpsl add failed");
      const be = toBotError(err);
      const hintLine = be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``;
      const retryLine = be.retryable ? fmt`\n\n↩️ ${FormattedString.i("Safe to retry.")}` : fmt``;
      const errMsg = fmt`${FormattedString.b(`❌ ${legLabel(leg)} failed`)}\n\n${be.userMessage}${hintLine}${retryLine}`;
      const kb = new InlineKeyboard()
        .text("Try again", `tpsl:open:${leg}:${symbol}:${side}`)
        .text("✕ Close", "cancel");
      try {
        await api.editMessageText(chatId, msgId, errMsg.text, {
          entities: errMsg.entities,
          reply_markup: kb,
        });
      } catch (editErr) {
        logger.warn({ err: editErr }, "tpsl error edit failed");
      }
    } finally {
      await redis.del(lockKey);
    }
  })().catch((err) => logger.error({ err }, "tpsl add async error"));
}

// ── Per-rung row action sheet ───────────────────────────────────────────────

async function sendRowMenu(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  idx: number,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  const rung = data.rungs.find((r) => r.leg === leg && r.conditionalOrderIndex === idx);
  if (!rung) {
    await sendTpSlManager(ctx, leg, symbol, side, true);
    return;
  }

  const otherMode: ExecMode = rung.mode === "limit" ? "market" : "limit";
  const sizeTokens = Number(rung.maxSizeLots) * 10 ** -data.market.baseLotsDecimals;

  const kb = new InlineKeyboard()
    .text("✏️ Change price", `tpsl:editpx:${leg}:${symbol}:${side}:${idx}`)
    .text("✏️ Change size", `tpsl:editsz:${leg}:${symbol}:${side}:${idx}`)
    .row()
    .text(`🔁 Switch to ${otherMode}`, `tpsl:flipmd:${leg}:${symbol}:${side}:${idx}`)
    .text("🗑 Remove", `tpsl:rm:${leg}:${symbol}:${side}:${idx}`)
    .row()
    .text("← Back to manager", `tpsl:open:${leg}:${symbol}:${side}`);

  const msg = fmt`${legEmoji(leg)} ${FormattedString.b(`${legLabel(leg)} #${idx} — ${symbol}`)}

Price     ${FormattedString.b(fmtPrice(rung.triggerPrice))}
Size      ${FormattedString.b(`${sizeTokens.toFixed(Math.min(4, data.market.baseLotsDecimals))} ${symbol}`)}
Mode      ${FormattedString.b(rung.mode)}`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  } else {
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  }
}

// ── Flip mode (atomic cancel + place with same price/size, new mode) ────────

async function executeFlipMode(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  idx: number,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  if (!(await checkOrderRateLimit(ctx))) return;
  if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery?.id ?? ""))) return;

  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  const rung = data.rungs.find((r) => r.leg === leg && r.conditionalOrderIndex === idx);
  if (!rung) {
    await sendTpSlManager(ctx, leg, symbol, side, true);
    return;
  }

  const newMode: ExecMode = rung.mode === "limit" ? "market" : "limit";
  const user = ctx.user;
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (!chatId || !msgId) return;
  const api = ctx.api;

  await ctx.editMessageText("⏳ Switching mode…");

  void (async () => {
    try {
      const s = await getSettings(user.id);
      const fee = getFeeConfig(s.feeMode, s.customFeeSol);
      const rungInput: RungInput = {
        leg,
        triggerPrice: rung.triggerPrice,
        mode: newMode,
        size: { kind: "lots", lots: rung.maxSizeLots },
      };
      await setPositionTpSl(
        {
          symbol,
          walletAddress: user.walletAddress,
          positionSide: side,
          tp: leg === "tp" ? [rungInput] : [],
          sl: leg === "sl" ? [rungInput] : [],
          cancelTpIndices: leg === "tp" ? [idx] : [],
          cancelSlIndices: leg === "sl" ? [idx] : [],
        },
        fee,
      );
      const kb = new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`);
      const okMsg = fmt`✅ Mode switched to ${FormattedString.b(newMode)} for ${legLabel(leg)} #${idx}.`;
      await api.editMessageText(chatId, msgId, okMsg.text, {
        entities: okMsg.entities,
        reply_markup: kb,
      });
    } catch (err) {
      logger.error({ err, symbol, leg, idx }, "tpsl flip mode failed");
      const be = toBotError(err);
      const errMsg = fmt`${FormattedString.b("❌ Switch failed")}\n\n${be.userMessage}`;
      const kb = new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`);
      try {
        await api.editMessageText(chatId, msgId, errMsg.text, {
          entities: errMsg.entities,
          reply_markup: kb,
        });
      } catch (editErr) {
        logger.warn({ err: editErr }, "tpsl flip mode edit error");
      }
    }
  })().catch((err) => logger.error({ err }, "tpsl flip mode async error"));
}

// ── Remove single rung ──────────────────────────────────────────────────────

async function sendRemoveConfirm(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  idx: number,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  const rung = data.rungs.find((r) => r.leg === leg && r.conditionalOrderIndex === idx);
  if (!rung) {
    await sendTpSlManager(ctx, leg, symbol, side, true);
    return;
  }
  const kb = new InlineKeyboard()
    .text("🗑 Confirm remove", `tpsl:rmgo:${leg}:${symbol}:${side}:${idx}`)
    .text("✕ Cancel", `tpsl:row:${leg}:${symbol}:${side}:${idx}`);
  const msg = fmt`Remove ${legLabel(leg)} #${idx} at ${FormattedString.b(fmtPrice(rung.triggerPrice))}?`;
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function executeRemove(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  idx: number,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  if (!(await checkOrderRateLimit(ctx))) return;
  if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery?.id ?? ""))) return;

  const user = ctx.user;
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (!chatId || !msgId) return;
  const api = ctx.api;

  await ctx.editMessageText("⏳ Removing…");

  void (async () => {
    try {
      const s = await getSettings(user.id);
      const fee = getFeeConfig(s.feeMode, s.customFeeSol);
      await cancelPositionConditional(user.walletAddress, symbol, side, leg, idx, fee);
      const kb = new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`);
      const okMsg = fmt`✅ ${legLabel(leg)} #${idx} removed.`;
      await api.editMessageText(chatId, msgId, okMsg.text, {
        entities: okMsg.entities,
        reply_markup: kb,
      });
    } catch (err) {
      logger.error({ err, symbol, leg, idx }, "tpsl remove failed");
      const be = toBotError(err);
      const errMsg = fmt`${FormattedString.b("❌ Remove failed")}\n\n${be.userMessage}`;
      const kb = new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`);
      try {
        await api.editMessageText(chatId, msgId, errMsg.text, {
          entities: errMsg.entities,
          reply_markup: kb,
        });
      } catch (editErr) {
        logger.warn({ err: editErr }, "tpsl remove edit error");
      }
    }
  })().catch((err) => logger.error({ err }, "tpsl remove async error"));
}

// ── Clear all ───────────────────────────────────────────────────────────────

async function sendClearAllConfirm(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  const count = data.rungs.filter((r) => r.leg === leg).length;
  if (count === 0) {
    await sendTpSlManager(ctx, leg, symbol, side, true);
    return;
  }
  const kb = new InlineKeyboard()
    .text(`🗑 Clear all ${count}`, `tpsl:clrgo:${leg}:${symbol}:${side}`)
    .text("✕ Cancel", `tpsl:open:${leg}:${symbol}:${side}`);
  const msg = fmt`Remove all ${count} ${legLabel(leg).toLowerCase()} levels on ${symbol}?`;
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function executeClearAll(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  if (!(await checkOrderRateLimit(ctx))) return;
  if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery?.id ?? ""))) return;

  const user = ctx.user;
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (!chatId || !msgId) return;
  const api = ctx.api;

  await ctx.editMessageText("⏳ Removing all levels…");

  void (async () => {
    try {
      const s = await getSettings(user.id);
      const fee = getFeeConfig(s.feeMode, s.customFeeSol);
      await cancelAllPositionConditionals(user.walletAddress, symbol, side, leg, fee);
      const kb = new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`);
      const okMsg = fmt`✅ All ${legLabel(leg).toLowerCase()} levels removed.`;
      await api.editMessageText(chatId, msgId, okMsg.text, {
        entities: okMsg.entities,
        reply_markup: kb,
      });
    } catch (err) {
      logger.error({ err, symbol, leg }, "tpsl clear all failed");
      const be = toBotError(err);
      const errMsg = fmt`${FormattedString.b("❌ Clear failed")}\n\n${be.userMessage}`;
      const kb = new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`);
      try {
        await api.editMessageText(chatId, msgId, errMsg.text, {
          entities: errMsg.entities,
          reply_markup: kb,
        });
      } catch (editErr) {
        logger.warn({ err: editErr }, "tpsl clear edit error");
      }
    }
  })().catch((err) => logger.error({ err }, "tpsl clear async error"));
}

// ── Edit flows ──────────────────────────────────────────────────────────────

async function sendEditPriceStep(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  idx: number,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  if (!data.rungs.find((r) => r.leg === leg && r.conditionalOrderIndex === idx)) {
    await sendTpSlManager(ctx, leg, symbol, side, true);
    return;
  }
  if (!ctx.from) return;
  await clearPending(ctx.from.id);
  await setPending(ctx.from.id, `tpsl_editpx:${leg}:${symbol}:${side}:${idx}`);

  const mark = Number(data.pos.markPrice);
  const msg = fmt`✏️ ${FormattedString.b(`Edit price — ${legLabel(leg)} #${idx}`)}

Current mark: ${FormattedString.b(fmtPrice(mark))}

Send the new trigger price (USD).`;
  const kb = new InlineKeyboard().text("✕ Cancel", `tpsl:row:${leg}:${symbol}:${side}:${idx}`);
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendEditSizeStep(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  idx: number,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  const rung = data.rungs.find((r) => r.leg === leg && r.conditionalOrderIndex === idx);
  if (!rung) {
    await sendTpSlManager(ctx, leg, symbol, side, true);
    return;
  }
  if (!ctx.from) return;
  await clearPending(ctx.from.id);
  await setPending(ctx.from.id, `tpsl_editsz:${leg}:${symbol}:${side}:${idx}`);

  const sizeTokens = Number(rung.maxSizeLots) * 10 ** -data.market.baseLotsDecimals;
  const msg = fmt`✏️ ${FormattedString.b(`Edit size — ${legLabel(leg)} #${idx}`)}

Current: ${FormattedString.b(`${sizeTokens.toFixed(Math.min(4, data.market.baseLotsDecimals))} ${symbol}`)}

Send the new size (in tokens).`;
  const kb = new InlineKeyboard().text("✕ Cancel", `tpsl:row:${leg}:${symbol}:${side}:${idx}`);
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function executeEditCommit(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  idx: number,
  triggerPrice: number,
  sizeLots: bigint,
  mode: ExecMode,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  if (!(await checkOrderRateLimit(ctx))) return;
  if (!(await claimIdempotencyKey(ctx.from.id, `edit:${leg}:${symbol}:${side}:${idx}`))) return;

  const user = ctx.user;
  const chatId = ctx.chat?.id;
  const msgId = ctx.message?.message_id;
  if (!chatId || !msgId) return;
  const api = ctx.api;

  const lockKey = `trade:lock:${user.id}`;
  const locked = await redis.set(lockKey, "1", "EX", TRADE_LOCK_TTL, "NX");
  if (!locked) {
    await api.sendMessage(chatId, "Another trade is in progress. Wait a moment and try again.");
    return;
  }

  await api.sendMessage(chatId, `⏳ Updating ${legLabel(leg).toLowerCase()}…`);

  void (async () => {
    try {
      const s = await getSettings(user.id);
      const fee = getFeeConfig(s.feeMode, s.customFeeSol);
      const rungInput: RungInput = {
        leg,
        triggerPrice,
        mode,
        size: { kind: "lots", lots: sizeLots },
      };
      await setPositionTpSl(
        {
          symbol,
          walletAddress: user.walletAddress,
          positionSide: side,
          tp: leg === "tp" ? [rungInput] : [],
          sl: leg === "sl" ? [rungInput] : [],
          cancelTpIndices: leg === "tp" ? [idx] : [],
          cancelSlIndices: leg === "sl" ? [idx] : [],
        },
        fee,
      );
      await api.sendMessage(chatId, `✅ ${legLabel(leg)} #${idx} updated.`, {
        reply_markup: new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`),
      });
    } catch (err) {
      logger.error({ err, symbol, leg, idx }, "tpsl edit commit failed");
      const be = toBotError(err);
      await api.sendMessage(chatId, `❌ Edit failed: ${be.userMessage}`, {
        reply_markup: new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`),
      });
    } finally {
      await redis.del(lockKey);
    }
  })().catch((err) => logger.error({ err }, "tpsl edit commit async error"));
}

// ── Pending-state input handlers (called from src/bot/index.ts) ─────────────

export async function handleTpSlPriceInput(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  text: string,
  editIdx?: number,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  const price = parseAmount(text);
  if (!Number.isFinite(price) || price <= 0) {
    await ctx.reply("Invalid price. Enter a positive number.");
    return;
  }
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await clearPending(ctx.from.id);
    await sendPositionGone(ctx, false, `No open ${symbol} ${side} position.`);
    return;
  }
  try {
    validateTriggerPrice(price, leg, side, {
      markPrice: data.pos.markPrice,
      liquidationPrice: data.pos.liquidationPrice,
    });
  } catch (err) {
    const be = toBotError(err);
    await ctx.reply(`⚠️ ${be.userMessage}${be.hint ? `\n${be.hint}` : ""}`);
    return;
  }
  await clearPending(ctx.from.id);
  if (editIdx !== undefined) {
    const existing = data.rungs.find((r) => r.leg === leg && r.conditionalOrderIndex === editIdx);
    if (!existing) {
      await sendTpSlManager(ctx, leg, symbol, side, false);
      return;
    }
    await executeEditCommit(
      ctx,
      leg,
      symbol,
      side,
      editIdx,
      price,
      existing.maxSizeLots,
      existing.mode,
    );
    return;
  }
  // Route to size step
  await sendSizeStep(ctx, leg, symbol, side, priceForCb(price), false);
}

export async function handleTpSlSizeInput(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  priceStr: string,
  text: string,
  editIdx?: number,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  const tokens = parseAmount(text);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    await ctx.reply("Invalid size. Enter a positive number.");
    return;
  }
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await clearPending(ctx.from.id);
    await sendPositionGone(ctx, false, `No open ${symbol} ${side} position.`);
    return;
  }
  const sizeLots = resolveSize({ kind: "tokens", tokens }, data.positionLots, {
    baseLotsDecimals: data.market.baseLotsDecimals,
  });
  if (sizeLots <= 0n) {
    const minToken = 10 ** -data.market.baseLotsDecimals;
    await ctx.reply(
      `Size too small. Minimum ~${minToken.toFixed(data.market.baseLotsDecimals)} tokens.`,
    );
    return;
  }

  if (editIdx !== undefined) {
    const existing = data.rungs.find((r) => r.leg === leg && r.conditionalOrderIndex === editIdx);
    if (!existing) {
      await sendTpSlManager(ctx, leg, symbol, side, false);
      return;
    }
    const remainingMinusSelf =
      (leg === "tp" ? data.remainingLots.tp : data.remainingLots.sl) + existing.maxSizeLots;
    if (sizeLots > remainingMinusSelf) {
      const tokensRem = Number(remainingMinusSelf) * 10 ** -data.market.baseLotsDecimals;
      await ctx.reply(
        `Size exceeds available (${tokensRem.toFixed(Math.min(4, data.market.baseLotsDecimals))} max).`,
      );
      return;
    }
    await clearPending(ctx.from.id);
    await executeEditCommit(
      ctx,
      leg,
      symbol,
      side,
      editIdx,
      existing.triggerPrice,
      sizeLots,
      existing.mode,
    );
    return;
  }

  const remaining = leg === "tp" ? data.remainingLots.tp : data.remainingLots.sl;
  if (sizeLots > remaining) {
    const tokensRem = Number(remaining) * 10 ** -data.market.baseLotsDecimals;
    await ctx.reply(
      `Size exceeds remaining (${tokensRem.toFixed(Math.min(4, data.market.baseLotsDecimals))} max).`,
    );
    return;
  }
  await clearPending(ctx.from.id);
  await sendConfirmStep(
    ctx,
    leg,
    symbol,
    side,
    priceStr,
    sizeLots.toString(),
    defaultMode(leg),
    false,
  );
}

// ── Custom-price prompt (callback) ──────────────────────────────────────────

async function sendCustomPricePrompt(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  await clearPending(ctx.from.id);
  await setPending(ctx.from.id, `tpsl_px:${leg}:${symbol}:${side}`);
  const mark = Number(data.pos.markPrice);
  const greater = isGreaterDir(leg, side);
  const direction = greater ? "above" : "below";
  const msg = fmt`Enter trigger price for ${FormattedString.b(symbol)}:

Current mark: ${FormattedString.b(fmtPrice(mark))}
Must be ${direction} current price.`;
  const kb = new InlineKeyboard().text("✕ Cancel", `tpsl:open:${leg}:${symbol}:${side}`);
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendCustomSizePrompt(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  priceStr: string,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  await clearPending(ctx.from.id);
  await setPending(ctx.from.id, `tpsl_sz:${leg}:${symbol}:${side}:${priceStr}`);
  const remaining = leg === "tp" ? data.remainingLots.tp : data.remainingLots.sl;
  const remTokens = Number(remaining) * 10 ** -data.market.baseLotsDecimals;
  const msg = fmt`Enter size in ${symbol} tokens.

Max remaining: ${FormattedString.b(`${remTokens.toFixed(Math.min(4, data.market.baseLotsDecimals))} ${symbol}`)}`;
  const kb = new InlineKeyboard().text("✕ Cancel", `tpsl:open:${leg}:${symbol}:${side}`);
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

// FIX 3: split a single 100%-covering rung into a 50/50 ladder.
// Atomically cancels the existing rung and places two rungs:
//   - rung A at the existing price, 50% of position
//   - rung B at midpoint between existing price and a "+2x distance" price, 50%
// User can edit rung B's price afterward via the row menu.
async function sendSplitConfirm(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  const legRungs = data.rungs.filter((r) => r.leg === leg);
  if (legRungs.length !== 1) {
    await sendTpSlManager(ctx, leg, symbol, side, true);
    return;
  }
  const existing = legRungs[0];
  const entry = Number(data.pos.entryPrice);
  const distance = existing.triggerPrice - entry;
  const secondPrice = entry + distance * 2;
  const half = data.positionLots / 2n;
  const remainder = data.positionLots - half;

  const kb = new InlineKeyboard()
    .text(
      "🪜 Split 50/50",
      `tpsl:splitgo:${leg}:${symbol}:${side}:${existing.conditionalOrderIndex}:${priceForCb(secondPrice)}`,
    )
    .row()
    .text("✕ Cancel", `tpsl:open:${leg}:${symbol}:${side}`);

  const tokens1 = Number(half) * 10 ** -data.market.baseLotsDecimals;
  const tokens2 = Number(remainder) * 10 ** -data.market.baseLotsDecimals;
  const msg = fmt`🪜 ${FormattedString.b(`Split ${legLabel(leg)} into ladder`)}

Will replace the single 100% rung with two:
  ① ${FormattedString.b(fmtPrice(existing.triggerPrice))} — ${tokens1.toFixed(Math.min(4, data.market.baseLotsDecimals))} ${symbol} (50%)
  ② ${FormattedString.b(fmtPrice(secondPrice))} — ${tokens2.toFixed(Math.min(4, data.market.baseLotsDecimals))} ${symbol} (50%)

${FormattedString.i("You can edit either level's price/size after.")}`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  } else {
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  }
}

async function executeSplit(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  oldIdx: number,
  secondPriceStr: string,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;
  if (!(await checkOrderRateLimit(ctx))) return;
  if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery?.id ?? ""))) return;

  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  const existing = data.rungs.find((r) => r.leg === leg && r.conditionalOrderIndex === oldIdx);
  if (!existing) {
    await sendTpSlManager(ctx, leg, symbol, side, true);
    return;
  }

  const half = data.positionLots / 2n;
  const remainder = data.positionLots - half;
  const secondPrice = Number(secondPriceStr);

  const user = ctx.user;
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (!chatId || !msgId) return;
  const api = ctx.api;

  await ctx.editMessageText("⏳ Splitting into ladder…");

  void (async () => {
    try {
      const s = await getSettings(user.id);
      const fee = getFeeConfig(s.feeMode, s.customFeeSol);
      const rung1: RungInput = {
        leg,
        triggerPrice: existing.triggerPrice,
        mode: existing.mode,
        size: { kind: "lots", lots: half },
      };
      const rung2: RungInput = {
        leg,
        triggerPrice: secondPrice,
        mode: existing.mode,
        size: { kind: "lots", lots: remainder },
      };
      await setPositionTpSl(
        {
          symbol,
          walletAddress: user.walletAddress,
          positionSide: side,
          tp: leg === "tp" ? [rung1, rung2] : [],
          sl: leg === "sl" ? [rung1, rung2] : [],
          cancelTpIndices: leg === "tp" ? [oldIdx] : [],
          cancelSlIndices: leg === "sl" ? [oldIdx] : [],
        },
        fee,
      );
      const kb = new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`);
      const okMsg = fmt`✅ ${FormattedString.b(`${legLabel(leg)} split into 2 levels.`)}\n\n${FormattedString.i("Tap a level in the manager to fine-tune price or size.")}`;
      await api.editMessageText(chatId, msgId, okMsg.text, {
        entities: okMsg.entities,
        reply_markup: kb,
      });
    } catch (err) {
      logger.error({ err, symbol, leg }, "tpsl split failed");
      const be = toBotError(err);
      const errMsg = fmt`${FormattedString.b("❌ Split failed")}\n\n${be.userMessage}`;
      const kb = new InlineKeyboard().text("← Manager", `tpsl:open:${leg}:${symbol}:${side}`);
      try {
        await api.editMessageText(chatId, msgId, errMsg.text, {
          entities: errMsg.entities,
          reply_markup: kb,
        });
      } catch (editErr) {
        logger.warn({ err: editErr }, "tpsl split edit error");
      }
    }
  })().catch((err) => logger.error({ err }, "tpsl split async error"));
}

// FIX 1: route empty-state preset through size step so user sees ladder options
async function handleEmptyPreset(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  presetPct: number,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  const mark = Number(data.pos.markPrice);
  const triggerPrice = pctToTriggerPrice(leg, side, mark, presetPct);
  await sendSizeStep(ctx, leg, symbol, side, priceForCb(triggerPrice), true);
}

// ── Populated preset → goes to size step ────────────────────────────────────

async function handlePopulatedPreset(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  side: "long" | "short",
  presetPct: number,
): Promise<void> {
  if (!ctx.user) return;
  const data = await loadPositionCtx(ctx.user.walletAddress, symbol, side);
  if (!data) {
    await sendPositionGone(ctx, true, `No open ${symbol} ${side} position.`);
    return;
  }
  const mark = Number(data.pos.markPrice);
  const triggerPrice = pctToTriggerPrice(leg, side, mark, presetPct);
  await sendSizeStep(ctx, leg, symbol, side, priceForCb(triggerPrice), true);
}

// ── Register ────────────────────────────────────────────────────────────────

const LEG_RE = "(tp|sl)";
const SIDE_RE = "(long|short)";
const SYM_RE = "([A-Z0-9]+)";

export function registerTpSl(bot: Bot<BotContext>) {
  // Open manager
  bot.callbackQuery(new RegExp(`^tpsl:open:${LEG_RE}:${SYM_RE}:${SIDE_RE}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    const [leg, sym, side] = ctx.match.slice(1) as [Leg, string, "long" | "short"];
    await sendTpSlManager(ctx, leg, shortSym(sym), side, true);
  });

  // Empty-state preset → confirm directly (size full, mode default)
  bot.callbackQuery(new RegExp(`^tpsl:px:${LEG_RE}:${SYM_RE}:${SIDE_RE}:(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [leg, sym, side, pctStr] = ctx.match.slice(1) as [Leg, string, "long" | "short", string];
    await handleEmptyPreset(ctx, leg, shortSym(sym), side, Number(pctStr));
  });

  // Populated preset → size step
  bot.callbackQuery(new RegExp(`^tpsl:px2:${LEG_RE}:${SYM_RE}:${SIDE_RE}:(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [leg, sym, side, pctStr] = ctx.match.slice(1) as [Leg, string, "long" | "short", string];
    await handlePopulatedPreset(ctx, leg, shortSym(sym), side, Number(pctStr));
  });

  // Custom price prompt
  bot.callbackQuery(new RegExp(`^tpsl:pxc:${LEG_RE}:${SYM_RE}:${SIDE_RE}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [leg, sym, side] = ctx.match.slice(1) as [Leg, string, "long" | "short"];
    await sendCustomPricePrompt(ctx, leg, shortSym(sym), side);
  });

  // Add wizard entry (price step)
  bot.callbackQuery(new RegExp(`^tpsl:add:${LEG_RE}:${SYM_RE}:${SIDE_RE}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [leg, sym, side] = ctx.match.slice(1) as [Leg, string, "long" | "short"];
    await sendPriceStep(ctx, leg, shortSym(sym), side, true);
  });

  // Size step from preset
  bot.callbackQuery(
    new RegExp(`^tpsl:sz:${LEG_RE}:${SYM_RE}:${SIDE_RE}:([\\d.]+):(\\d+)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.user) return;
      const [leg, sym, side, priceStr, pctStr] = ctx.match.slice(1) as [
        Leg,
        string,
        "long" | "short",
        string,
        string,
      ];
      const data = await loadPositionCtx(ctx.user.walletAddress, shortSym(sym), side);
      if (!data) {
        await sendPositionGone(ctx, true, `No open ${shortSym(sym)} ${side} position.`);
        return;
      }
      const remaining = leg === "tp" ? data.remainingLots.tp : data.remainingLots.sl;
      const lots = (remaining * BigInt(Number(pctStr))) / 100n;
      if (lots <= 0n) {
        await ctx.editMessageText("Size resolves to zero. Choose a larger %.");
        return;
      }
      await sendConfirmStep(
        ctx,
        leg,
        shortSym(sym),
        side,
        priceStr,
        lots.toString(),
        defaultMode(leg),
        true,
      );
    },
  );

  // Custom size prompt
  bot.callbackQuery(
    new RegExp(`^tpsl:szc:${LEG_RE}:${SYM_RE}:${SIDE_RE}:([\\d.]+)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.user) return;
      const [leg, sym, side, priceStr] = ctx.match.slice(1) as [
        Leg,
        string,
        "long" | "short",
        string,
      ];
      await sendCustomSizePrompt(ctx, leg, shortSym(sym), side, priceStr);
    },
  );

  // Mode toggle (re-render confirm)
  bot.callbackQuery(
    new RegExp(`^tpsl:md:${LEG_RE}:${SYM_RE}:${SIDE_RE}:([\\d.]+):(\\d+):(limit|market)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.user) return;
      const [leg, sym, side, priceStr, lotsStr, modeStr] = ctx.match.slice(1) as [
        Leg,
        string,
        "long" | "short",
        string,
        string,
        ExecMode,
      ];
      await sendConfirmStep(ctx, leg, shortSym(sym), side, priceStr, lotsStr, modeStr, true);
    },
  );

  // Submit
  bot.callbackQuery(
    new RegExp(`^tpsl:go:${LEG_RE}:${SYM_RE}:${SIDE_RE}:([\\d.]+):(\\d+):(limit|market)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery("Submitting…");
      if (!ctx.user) return;
      if (!(await requireActivation(ctx))) return;
      const [leg, sym, side, priceStr, lotsStr, modeStr] = ctx.match.slice(1) as [
        Leg,
        string,
        "long" | "short",
        string,
        string,
        ExecMode,
      ];
      await executeAdd(ctx, leg, shortSym(sym), side, priceStr, lotsStr, modeStr);
    },
  );

  // Row menu
  bot.callbackQuery(new RegExp(`^tpsl:row:${LEG_RE}:${SYM_RE}:${SIDE_RE}:(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [leg, sym, side, idxStr] = ctx.match.slice(1) as [Leg, string, "long" | "short", string];
    await sendRowMenu(ctx, leg, shortSym(sym), side, Number(idxStr));
  });

  // Flip mode (one-tap)
  bot.callbackQuery(
    new RegExp(`^tpsl:flipmd:${LEG_RE}:${SYM_RE}:${SIDE_RE}:(\\d+)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery("Switching…");
      if (!ctx.user) return;
      const [leg, sym, side, idxStr] = ctx.match.slice(1) as [
        Leg,
        string,
        "long" | "short",
        string,
      ];
      await executeFlipMode(ctx, leg, shortSym(sym), side, Number(idxStr));
    },
  );

  // Edit price (start)
  bot.callbackQuery(
    new RegExp(`^tpsl:editpx:${LEG_RE}:${SYM_RE}:${SIDE_RE}:(\\d+)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.user) return;
      const [leg, sym, side, idxStr] = ctx.match.slice(1) as [
        Leg,
        string,
        "long" | "short",
        string,
      ];
      await sendEditPriceStep(ctx, leg, shortSym(sym), side, Number(idxStr));
    },
  );

  // Edit size (start)
  bot.callbackQuery(
    new RegExp(`^tpsl:editsz:${LEG_RE}:${SYM_RE}:${SIDE_RE}:(\\d+)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.user) return;
      const [leg, sym, side, idxStr] = ctx.match.slice(1) as [
        Leg,
        string,
        "long" | "short",
        string,
      ];
      await sendEditSizeStep(ctx, leg, shortSym(sym), side, Number(idxStr));
    },
  );

  // Remove confirm
  bot.callbackQuery(new RegExp(`^tpsl:rm:${LEG_RE}:${SYM_RE}:${SIDE_RE}:(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [leg, sym, side, idxStr] = ctx.match.slice(1) as [Leg, string, "long" | "short", string];
    await sendRemoveConfirm(ctx, leg, shortSym(sym), side, Number(idxStr));
  });

  // Remove exec
  bot.callbackQuery(
    new RegExp(`^tpsl:rmgo:${LEG_RE}:${SYM_RE}:${SIDE_RE}:(\\d+)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery("Removing…");
      if (!ctx.user) return;
      if (!(await requireActivation(ctx))) return;
      const [leg, sym, side, idxStr] = ctx.match.slice(1) as [
        Leg,
        string,
        "long" | "short",
        string,
      ];
      await executeRemove(ctx, leg, shortSym(sym), side, Number(idxStr));
    },
  );

  // Clear all confirm
  bot.callbackQuery(new RegExp(`^tpsl:clr:${LEG_RE}:${SYM_RE}:${SIDE_RE}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [leg, sym, side] = ctx.match.slice(1) as [Leg, string, "long" | "short"];
    await sendClearAllConfirm(ctx, leg, shortSym(sym), side);
  });

  // Clear all exec
  bot.callbackQuery(new RegExp(`^tpsl:clrgo:${LEG_RE}:${SYM_RE}:${SIDE_RE}$`), async (ctx) => {
    await ctx.answerCallbackQuery("Clearing…");
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    const [leg, sym, side] = ctx.match.slice(1) as [Leg, string, "long" | "short"];
    await executeClearAll(ctx, leg, shortSym(sym), side);
  });

  // FIX 3: Split single 100% rung into ladder — confirm
  bot.callbackQuery(new RegExp(`^tpsl:split:${LEG_RE}:${SYM_RE}:${SIDE_RE}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [leg, sym, side] = ctx.match.slice(1) as [Leg, string, "long" | "short"];
    await sendSplitConfirm(ctx, leg, shortSym(sym), side);
  });

  // Split exec
  bot.callbackQuery(
    new RegExp(`^tpsl:splitgo:${LEG_RE}:${SYM_RE}:${SIDE_RE}:(\\d+):([\\d.]+)$`),
    async (ctx) => {
      await ctx.answerCallbackQuery("Splitting…");
      if (!ctx.user) return;
      if (!(await requireActivation(ctx))) return;
      const [leg, sym, side, idxStr, priceStr] = ctx.match.slice(1) as [
        Leg,
        string,
        "long" | "short",
        string,
        string,
      ];
      await executeSplit(ctx, leg, shortSym(sym), side, Number(idxStr), priceStr);
    },
  );

  // Legacy shims: old editsl: / edittp: → forward to new manager
  bot.callbackQuery(/^editsl:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [sym, side] = ctx.match.slice(1) as [string, "long" | "short"];
    await sendTpSlManager(ctx, "sl", shortSym(sym), side, false);
  });
  bot.callbackQuery(/^edittp:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [sym, side] = ctx.match.slice(1) as [string, "long" | "short"];
    await sendTpSlManager(ctx, "tp", shortSym(sym), side, false);
  });
}
