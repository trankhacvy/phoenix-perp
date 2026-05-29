import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { InlineKeyboard, InputFile } from "grammy";
import type { Bot } from "grammy";
import { tokensToLots } from "../../lib/amount.js";
import { logger } from "../../lib/logger.js";
import { generatePnlCard } from "../../services/image.js";
import {
  type ConditionalRung,
  getPositionConditionals,
} from "../../services/phoenix/conditional.js";
import { getMarket } from "../../services/phoenix/market.js";
import { getTraderState } from "../../services/phoenix/position.js";
import {
  type FeeConfig,
  addMargin,
  closePosition,
  getFeeConfig,
} from "../../services/phoenix/trade.js";
import { getSettings } from "../../services/settings.js";
import { recordTrade } from "../../services/trade-log.js";
import type { BotContext, PhoenixPosition } from "../../types/index.js";
import { positionKeyboard } from "../keyboards/position.js";
import { requireActivation } from "../lib/activation.js";
import {
  cryptoSize,
  price as fmtPrice,
  num,
  pct,
  percentAbs,
  pnlEmoji,
  signedUsd,
  usd,
} from "../lib/fmt.js";
import { claimIdempotencyKey } from "../lib/idempotent.js";
import { setPending } from "../lib/pending.js";
import { CONFIRMING, TX_MSG_OPTS, txError, txSuccess } from "../lib/tx-flow.js";
import { checkOrderRateLimit } from "../middleware/rate-limit.js";
import { invalidateCtx } from "./tpsl.js";

const CIRCLE_NUMS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function circleNum(i: number): string {
  return CIRCLE_NUMS[i] ?? `${i + 1}.`;
}

function calcPnlPct(pos: PhoenixPosition): number | null {
  const upnl = Number(pos.unrealizedPnl);
  const entry = Number(pos.entryPrice);
  const size = Number(pos.size);
  const lev = pos.leverage ?? 1;
  if (Number.isNaN(upnl) || Number.isNaN(entry) || Number.isNaN(size) || entry === 0) return null;
  const margin = (entry * size) / lev;
  return margin > 0 ? (upnl / margin) * 100 : null;
}

function formatLiqValue(pos: PhoenixPosition): { text: string; warn: boolean } {
  if (pos.liquidationPrice === "N/A") return { text: "Safe ✅", warn: false };
  const liq = Number(pos.liquidationPrice);
  const mark = Number(pos.markPrice);
  if (Number.isNaN(liq) || Number.isNaN(mark) || mark === 0 || liq <= 0) {
    return { text: "Safe ✅", warn: false };
  }
  const dist = pos.side === "long" ? ((mark - liq) / mark) * 100 : ((liq - mark) / mark) * 100;
  return {
    text: `${fmtPrice(liq)}  (–${num(dist, 1, 1)}%)`,
    warn: dist < 5,
  };
}

// ─── List view ────────────────────────────────────────────────────────────────

export function buildPositionRows(
  positions: PhoenixPosition[],
  botUsername: string,
): FormattedString[] {
  return positions.map((pos, i) => {
    const upnl = Number(pos.unrealizedPnl);
    const upnlPct = calcPnlPct(pos);
    const sideLabel = pos.side === "long" ? "LONG" : "SHORT";
    const levLabel = pos.leverage ? ` ${pos.leverage}x` : "";
    const pnlStr = upnlPct != null ? `${signedUsd(upnl)} (${pct(upnlPct)})` : signedUsd(upnl);
    const deepLink = `https://t.me/${botUsername}?start=pos_${pos.symbol}_${pos.side}`;
    const liq = formatLiqValue(pos);
    const warnTag = liq.warn ? " ⚠️" : "";

    return FormattedString.join(
      [
        FormattedString.link(`${circleNum(i)}  ${pos.symbol} - ${sideLabel}${levLabel}`, deepLink),
        fmt`   ${FormattedString.b(pnlStr)} ${pnlEmoji(upnl)}  |  Liq ${FormattedString.b(liq.text)}${warnTag}`,
      ],
      "\n",
    );
  });
}

function buildListText(
  positions: PhoenixPosition[],
  totalUpnl: number,
  botUsername: string,
): FormattedString {
  const header = fmt`📊 ${FormattedString.b(`Open Positions (${positions.length})`)}   Total uPnL: ${FormattedString.b(signedUsd(totalUpnl))} ${pnlEmoji(totalUpnl)}`;
  return FormattedString.join([header, ...buildPositionRows(positions, botUsername)], "\n\n");
}

function buildListKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Refresh", "pos:refresh")
    .row()
    .text("🟢 New Long", "nav:long")
    .text("🔴 New Short", "nav:short");
}

export async function sendPositionsScreen(ctx: BotContext, edit = false): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const positions = state.positions ?? [];

  if (positions.length === 0) {
    const kb = new InlineKeyboard().text("🟢 Long", "nav:long").text("🔴 Short", "nav:short");
    const text = "You have no open positions.\n\nReady to trade?";
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: kb });
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
    return;
  }

  const totalUpnl = Number(state.unrealizedPnl);
  const botUsername = ctx.me.username ?? "bot";
  const msg = buildListText(positions, totalUpnl, botUsername);
  const kb = buildListKeyboard();

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
  } else {
    await ctx.reply(msg.text, {
      entities: msg.entities,
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
  }
}

// ─── Detail view ─────────────────────────────────────────────────────────────

function rungPctOfPosition(lots: bigint, positionLots: bigint): number {
  if (positionLots <= 0n) return 0;
  return Number((lots * 10000n) / positionLots) / 100;
}

function estimateRungPnl(
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

function liqDistanceDot(distancePct: number): string {
  if (distancePct >= 15) return "🟢";
  if (distancePct >= 5) return "🟡";
  return "🔴";
}

function buildTpSection(
  rungs: ConditionalRung[],
  positionLots: bigint,
  entry: number,
  side: "long" | "short",
  baseLotsDecimals: number,
  margin: number,
): FormattedString {
  if (rungs.length === 0) {
    return fmt`🎯 ${FormattedString.b("Take Profit")}  ·  ${FormattedString.i("not set")}`;
  }
  if (positionLots <= 0n) {
    return fmt`🎯 ${FormattedString.b("Take Profit")}  ·  ${rungs.length} level${rungs.length > 1 ? "s" : ""} set`;
  }
  const totalLots = rungs.reduce<bigint>((s, r) => s + r.maxSizeLots, 0n);
  const totalPct = rungPctOfPosition(totalLots, positionLots);
  const header = fmt`🎯 ${FormattedString.b("Take Profit")}  ·  ${percentAbs(totalPct, 0)} planned`;

  const lines: FormattedString[] = [header];
  let totalPnl = 0;
  for (let i = 0; i < rungs.length; i++) {
    const r = rungs[i];
    const sizePct = rungPctOfPosition(r.maxSizeLots, positionLots);
    const estPnl = estimateRungPnl(r.triggerPrice, entry, side, r.maxSizeLots, baseLotsDecimals);
    totalPnl += estPnl;
    lines.push(
      fmt`  ${circleNum(i)} ${FormattedString.b(fmtPrice(r.triggerPrice))} ${r.mode}  ·  close ${percentAbs(sizePct, 0)}  →  est ${FormattedString.b(signedUsd(estPnl))}`,
    );
  }
  if (rungs.length > 1) {
    const mult = margin > 0 ? totalPnl / margin : null;
    const multStr = mult !== null ? `  (${num(mult, 2, 2)}× margin)` : "";
    lines.push(fmt`  ${FormattedString.i(`If all fill: ${signedUsd(totalPnl)}${multStr}`)}`);
  }
  return FormattedString.join(lines, "\n");
}

function buildSlSection(
  rungs: ConditionalRung[],
  positionLots: bigint,
  entry: number,
  side: "long" | "short",
  baseLotsDecimals: number,
): { text: FormattedString; status: "none" | "partial" | "full" } {
  if (rungs.length === 0) {
    return {
      text: fmt`🛑 ${FormattedString.b("Stop Loss")}  ·  ${FormattedString.i("⚠️ not set — unlimited downside")}`,
      status: "none",
    };
  }
  if (positionLots <= 0n) {
    return {
      text: fmt`🛑 ${FormattedString.b("Stop Loss")}  ·  ${rungs.length} level${rungs.length > 1 ? "s" : ""} set`,
      status: "partial",
    };
  }
  const totalLots = rungs.reduce<bigint>((s, r) => s + r.maxSizeLots, 0n);
  const totalPct = rungPctOfPosition(totalLots, positionLots);
  const fully = totalPct >= 99.5;
  const status: "none" | "partial" | "full" = fully ? "full" : "partial";

  const headerLabel = fully
    ? `${percentAbs(totalPct, 0)} protected`
    : `⚠️ only ${percentAbs(totalPct, 0)} protected`;
  const header = fmt`🛑 ${FormattedString.b("Stop Loss")}  ·  ${FormattedString.b(headerLabel)}`;

  const lines: FormattedString[] = [header];
  let totalLoss = 0;
  for (let i = 0; i < rungs.length; i++) {
    const r = rungs[i];
    const sizePct = rungPctOfPosition(r.maxSizeLots, positionLots);
    const estPnl = estimateRungPnl(r.triggerPrice, entry, side, r.maxSizeLots, baseLotsDecimals);
    totalLoss += estPnl;
    lines.push(
      fmt`  ${circleNum(i)} ${FormattedString.b(fmtPrice(r.triggerPrice))} ${r.mode}  ·  close ${percentAbs(sizePct, 0)}  →  est ${FormattedString.b(signedUsd(estPnl))}`,
    );
  }
  if (!fully) {
    const gapPct = 100 - totalPct;
    lines.push(
      fmt`  ${FormattedString.i(`‼️ ${percentAbs(gapPct, 0)} of position has NO stop — keeps bleeding past the trigger`)}`,
    );
  } else if (rungs.length > 1) {
    lines.push(fmt`  ${FormattedString.i(`If all fill: ${signedUsd(totalLoss)}`)}`);
  }
  return { text: FormattedString.join(lines, "\n"), status };
}

function buildDetailText(
  pos: PhoenixPosition,
  unsettledFunding: number,
  tpRungs: ConditionalRung[],
  slRungs: ConditionalRung[],
  positionLots: bigint,
  baseLotsDecimals: number,
): {
  text: FormattedString;
  tpStatus: "none" | "partial" | "full";
  slStatus: "none" | "partial" | "full";
} {
  const sideEmoji = pos.side === "long" ? "🟢" : "🔴";
  const sideLabel = pos.side === "long" ? "LONG" : "SHORT";
  const levLabel = pos.leverage ? ` ${pos.leverage}×` : "";
  const marginLabel = pos.marginMode === "cross" ? "Cross" : "Isolated";

  const size = Number(pos.size);
  const entry = Number(pos.entryPrice);
  const mark = Number(pos.markPrice);
  const upnl = Number(pos.unrealizedPnl);
  const liq = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);

  const notional = mark * size;
  const lev = pos.leverage && pos.leverage > 0 ? pos.leverage : 1;
  const margin = notional / lev;

  const markPctFromEntry = entry > 0 ? ((mark - entry) / entry) * 100 : 0;
  const upnlPct = calcPnlPct(pos);
  const upnlPctStr = upnlPct !== null ? `  (${pct(upnlPct)} on margin)` : "";

  // TP / SL sections
  const tpSection = buildTpSection(
    tpRungs,
    positionLots,
    entry,
    pos.side,
    baseLotsDecimals,
    margin,
  );
  const slSection = buildSlSection(slRungs, positionLots, entry, pos.side, baseLotsDecimals);

  // Liquidation block
  let liqBlock: FormattedString;
  let tpStatus: "none" | "partial" | "full" = "none";
  if (tpRungs.length > 0) {
    const totalLots = tpRungs.reduce<bigint>((s, r) => s + r.maxSizeLots, 0n);
    const totalPct = rungPctOfPosition(totalLots, positionLots);
    tpStatus = totalPct >= 99.5 ? "full" : "partial";
  }

  if (liq > 0 && mark > 0) {
    const distRaw = pos.side === "long" ? ((mark - liq) / mark) * 100 : ((liq - mark) / mark) * 100;
    const dist = Math.max(0, distRaw);
    const dot = liqDistanceDot(dist);
    liqBlock = fmt`🚨 ${FormattedString.b("Liquidation")}
Price        ${FormattedString.b(fmtPrice(liq))}
Distance     ${FormattedString.b(`${percentAbs(dist, 1)} away`)} ${dot}
If hit       ${FormattedString.b(signedUsd(-margin))} margin ${FormattedString.i("(full wipe)")}`;
  } else {
    liqBlock = fmt`🚨 ${FormattedString.b("Liquidation")}    ${FormattedString.i("Safe ✅")}`;
  }

  // P&L block
  const fundingLine =
    Math.abs(unsettledFunding) > 0.001
      ? fmt`\nFunding      ${FormattedString.b(signedUsd(unsettledFunding))}  ${FormattedString.i(unsettledFunding < 0 ? "(you owe)" : "(owed to you)")}`
      : fmt``;

  const pnlBlock = fmt`📈 ${FormattedString.b("P&L")}
Mark         ${FormattedString.b(fmtPrice(mark))}  ${FormattedString.i(`(${pct(markPctFromEntry)} from entry)`)}
Unrealized   ${FormattedString.b(signedUsd(upnl))} ${pnlEmoji(upnl)}${FormattedString.i(upnlPctStr)}${fundingLine}`;

  // Top block
  const topBlock = fmt`${sideEmoji} ${FormattedString.b(`${pos.symbol} ${sideLabel}${levLabel}`)} · ${FormattedString.i(marginLabel)}
━━━━━━━━━━━━━━━━━━━━━━━━━

💰 Margin       ${FormattedString.b(usd(margin))}
📊 Exposure     ${FormattedString.b(`${cryptoSize(size, pos.symbol)}`)}  ${FormattedString.i(`(${usd(notional)} notional)`)}
Entry          ${FormattedString.b(fmtPrice(entry))}`;

  const text = FormattedString.join(
    [topBlock, fmt``, pnlBlock, fmt``, liqBlock, fmt``, tpSection, fmt``, slSection.text],
    "\n",
  );

  return { text, tpStatus, slStatus: slSection.status };
}

export async function sendPositionDetail(
  ctx: BotContext,
  symbol: string,
  side: "long" | "short",
  edit = false,
): Promise<void> {
  if (!ctx.user) return;
  const [state, rungs, market] = await Promise.all([
    getTraderState(ctx.user.walletAddress),
    getPositionConditionals(ctx.user.walletAddress, symbol, side).catch(() => []),
    getMarket(symbol).catch(() => null),
  ]);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);

  if (!pos) {
    const text = `No open ${symbol} ${side} position found.`;
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text);
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const tpRungs = rungs.filter((r) => r.leg === "tp");
  const slRungs = rungs.filter((r) => r.leg === "sl");

  const baseLotsDecimals = market ? market.baseLotsDecimals : 4;
  const positionLots = market ? tokensToLots(pos.size, baseLotsDecimals) : 0n;

  const unsettledFunding = Number(state.unsettledFunding);
  const built = buildDetailText(
    pos,
    unsettledFunding,
    tpRungs,
    slRungs,
    positionLots,
    baseLotsDecimals,
  );
  const kb = positionKeyboard(symbol, side, built.tpStatus, built.slStatus);

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(built.text.text, {
      entities: built.text.entities,
      reply_markup: kb,
    });
  } else {
    await ctx.reply(built.text.text, { entities: built.text.entities, reply_markup: kb });
  }
}

// ─── Command + callbacks ──────────────────────────────────────────────────────

export function registerPositions(bot: Bot<BotContext>) {
  bot.command("positions", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }
    if (!(await requireActivation(ctx))) return;
    await sendPositionsScreen(ctx);
  });

  // List navigation
  bot.callbackQuery("pos:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendPositionsScreen(ctx, true);
  });

  bot.callbackQuery("pos:refresh", async (ctx) => {
    await ctx.answerCallbackQuery("Refreshed");
    if (!ctx.user) return;
    try {
      await sendPositionsScreen(ctx, true);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes("message is not modified")) throw err;
    }
  });

  // Detail navigation
  bot.callbackQuery(/^pos:detail:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    await sendPositionDetail(ctx, symbol, side, true);
  });

  bot.callbackQuery(/^pos:refresh:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Refreshed");
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    try {
      await sendPositionDetail(ctx, symbol, side, true);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes("message is not modified")) throw err;
    }
  });

  // Close position — confirm prompt (or skip if confirmClose=false)
  bot.callbackQuery(/^close:([A-Z0-9]+):(\d+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, pctStr, side] = ctx.match.slice(1) as [string, string, "long" | "short"];
    const closePct = Number(pctStr);

    const settings = await getSettings(ctx.user.id);
    if (!settings.confirmClose) {
      if (!(await checkOrderRateLimit(ctx))) return;
      if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id))) return;
      const fee = getFeeConfig(settings.feeMode, settings.customFeeSol);
      await executeClose(ctx, symbol, closePct, side, fee);
      return;
    }
    const state = await getTraderState(ctx.user.walletAddress);
    const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);

    let detailLines = fmt``;
    if (pos) {
      const markPrice = Number(pos.markPrice);
      const totalSize = Number(pos.size);
      const closingSize = totalSize * (closePct / 100);
      const remainingSize = totalSize - closingSize;
      const closingUsdc = closingSize * markPrice;
      const estimatedPnl = Number(pos.unrealizedPnl) * (closePct / 100);
      const sideLabel = side === "long" ? "Long" : "Short";
      const remainingLine =
        closePct < 100
          ? fmt`\nRemaining:   ${FormattedString.b(`${num(remainingSize, 2, 4)} ${symbol}`)}`
          : fmt``;
      detailLines = fmt`\n\n${FormattedString.b(`${symbol} ${sideLabel} — close ${closePct}%`)}\n\nPrice now:   ${FormattedString.b(`~${fmtPrice(markPrice)}`)}\nClosing:     ${FormattedString.b(`${num(closingSize, 2, 4)} ${symbol}  (${usd(closingUsdc, 0, 0)})`)}\nEst. P&L:    ${FormattedString.b(signedUsd(estimatedPnl))} ${FormattedString.i("(excl. fees)")}${remainingLine}`;
    }
    const label = closePct === 100 ? "Close all" : `Close ${closePct}%`;
    const kb = new InlineKeyboard()
      .text(`✅ ${label}`, `close:exec:${symbol}:${closePct}:${side}`)
      .text("✕ Cancel", "cancel");

    const confirmMsg = fmt`Confirm close?${detailLines}`;
    await ctx.reply(confirmMsg.text, {
      entities: confirmMsg.entities,
      reply_markup: kb,
    });
  });

  // Close position — execute
  bot.callbackQuery(/^close:exec:([A-Z0-9]+):(\d+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Closing…");
    if (!ctx.user) return;
    if (!(await checkOrderRateLimit(ctx))) return;
    const [symbol, pctStr, side] = ctx.match.slice(1) as [string, string, "long" | "short"];

    if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id))) return;

    const settings = await getSettings(ctx.user.id);
    const fee = getFeeConfig(settings.feeMode, settings.customFeeSol);
    await executeClose(ctx, symbol, Number(pctStr), side, fee);
  });

  // Add margin — prompt
  bot.callbackQuery(/^margin:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const symbol = ctx.match[1];
    const state = await getTraderState(ctx.user.walletAddress);
    const pos = state.positions.find((p) => p.symbol === symbol);

    if (!pos) {
      await ctx.reply(`No open ${symbol} position found. It may have been closed.`);
      return;
    }

    const available = Number(state.effectiveCollateral);
    const liqLabel =
      pos.liquidationPrice === "N/A" ? "Safe" : fmtPrice(Number(pos.liquidationPrice));

    const promptMsg = fmt`💰 ${FormattedString.b(`Add Margin — ${symbol}`)}\n\nAvailable:         ${FormattedString.code(usd(available))}\nCurrent liq price: ${FormattedString.code(liqLabel)}\n\nHow much do you want to add? (USD)`;
    await ctx.reply(promptMsg.text, { entities: promptMsg.entities });
    await setPending(ctx.from.id, `addmargin:${symbol}`);
  });

  // Add margin — execute
  bot.callbackQuery(/^addmargin:exec:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Adding…");
    if (!ctx.user) return;
    if (!(await checkOrderRateLimit(ctx))) return;
    const [symbol, amtStr] = ctx.match.slice(1) as [string, string];
    const amount = Number(amtStr);

    if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id))) return;

    await ctx.editMessageText(CONFIRMING);

    const user = ctx.user;
    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    const api = ctx.api;

    if (!chatId || !msgId) return;

    (async () => {
      try {
        const s = await getSettings(user.id);
        const marginFee = getFeeConfig(s.feeMode, s.customFeeSol);
        const sig = await addMargin(symbol, user.walletAddress, amtStr, marginFee);
        // Margin/liq changed — drop the TP/SL Protect-screen cache for this symbol.
        invalidateCtx(user.walletAddress, symbol, "long");
        invalidateCtx(user.walletAddress, symbol, "short");
        const body = fmt`${FormattedString.b(usd(amount))} added to ${FormattedString.b(symbol)}.`;
        const doneMsg = txSuccess({ header: "Margin added", body, signature: sig });
        await api.editMessageText(chatId, msgId, doneMsg.text, {
          entities: doneMsg.entities,
          ...TX_MSG_OPTS,
        });
      } catch (e) {
        logger.error({ err: e, symbol, amount }, "addMargin failed");
        const { msg: errMsg } = txError(e, "Add margin");
        try {
          await api.editMessageText(chatId, msgId, errMsg.text, {
            entities: errMsg.entities,
          });
        } catch (editErr) {
          logger.warn({ err: editErr }, "failed to edit error message after addMargin failure");
        }
      }
    })().catch((err) => logger.error({ err }, "add margin async error"));
  });

  // Legacy editsl:/edittp: callbacks are forwarded to the new manager by
  // `registerTpSl` in tpsl.ts. No registration here.
}

async function executeClose(
  ctx: BotContext,
  symbol: string,
  closePct: number,
  side: "long" | "short",
  fee?: FeeConfig,
): Promise<void> {
  if (!ctx.user) return;
  const fraction = closePct / 100;

  // Snapshot before closing so realized PnL is reportable even on a full close.
  const pre = await getTraderState(ctx.user.walletAddress).catch(() => null);
  const prePos = pre?.positions.find((p) => p.symbol === symbol && p.side === side) ?? null;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(CONFIRMING);
  } else {
    await ctx.reply(CONFIRMING);
  }

  const user = ctx.user;
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery?.message?.message_id;
  const api = ctx.api;

  if (!chatId || !msgId) return;

  (async () => {
    let sig: string;
    try {
      sig = await closePosition(symbol, user.walletAddress, fraction, fee);
    } catch (e) {
      logger.error({ err: e, symbol, fraction }, "closePosition failed");
      const kb = new InlineKeyboard().text("← Back", "nav:positions");
      const { msg: errMsg } = txError(e, "Close position");
      try {
        await api.editMessageText(chatId, msgId, errMsg.text, {
          entities: errMsg.entities,
          reply_markup: kb,
        });
      } catch (editErr) {
        logger.warn({ err: editErr }, "failed to edit error message after close failure");
      }
      return;
    }
    // Position size changed — drop the TP/SL Protect-screen cache so it re-reads.
    invalidateCtx(user.walletAddress, symbol, side);

    if (prePos) {
      const markPrice = Number(prePos.markPrice);
      const totalSize = Number(prePos.size);
      const closingSize = totalSize * fraction;
      const notional = closingSize * markPrice;
      recordTrade({
        userId: user.id,
        walletAddress: user.walletAddress,
        symbol,
        side,
        action: "close",
        notionalUsdc: notional,
        baseUnits: closingSize.toString(),
        markPrice,
        closeFraction: fraction,
        txSignature: sig,
      });
    }

    const afterKb =
      fraction === 1
        ? new InlineKeyboard()
            .text("🟢 Long", "nav:long")
            .text("🔴 Short", "nav:short")
            .row()
            .text("📋 Positions", "nav:positions")
        : new InlineKeyboard()
            .text("📊 View position", `pos:detail:${symbol}:${side}`)
            .row()
            .text("📋 Positions", "nav:positions");

    const closedLabel = closePct === 100 ? "closed" : `${closePct}% closed`;
    let resultBody = fmt`${symbol} — ${FormattedString.b(closedLabel)}`;
    if (prePos) {
      const realized = Number(prePos.unrealizedPnl) * fraction;
      const margin =
        (Number(prePos.entryPrice) * Number(prePos.size)) / Math.max(prePos.leverage ?? 1, 1);
      const roi = margin > 0 ? (realized / margin) * 100 : null;
      const sideLabel = prePos.side === "long" ? "Long" : "Short";
      const roiPart = roi !== null ? FormattedString.i(`  (${pct(roi)})`) : fmt``;
      resultBody = fmt`${symbol} ${sideLabel} — ${FormattedString.b(closedLabel)}\nRealized:  ${FormattedString.b(signedUsd(realized))} ${pnlEmoji(realized)}${roiPart}`;
    }
    const successMsg = txSuccess({ header: "Position closed", body: resultBody, signature: sig });
    try {
      await api.editMessageText(chatId, msgId, successMsg.text, {
        entities: successMsg.entities,
        reply_markup: afterKb,
        ...TX_MSG_OPTS,
      });
    } catch (editErr) {
      logger.warn(
        { err: editErr, symbol, sig },
        "editMessageText failed after closePosition succeeded",
      );
    }

    if (prePos) {
      try {
        const pnl = Number(prePos.unrealizedPnl) * fraction;
        const leverage = prePos.leverage ?? 1;
        const margin = (Number(prePos.entryPrice) * Number(prePos.size)) / Math.max(leverage, 1);
        const roiPct = margin > 0 ? (pnl / margin) * 100 : 0;
        const card = await generatePnlCard({
          symbol,
          side: prePos.side,
          entryPrice: prePos.entryPrice,
          exitPrice: prePos.markPrice,
          roiPercent: roiPct,
          pnlUsdc: pnl,
        });
        await api.sendPhoto(chatId, new InputFile(card, "pnl.png"));
      } catch (cardErr) {
        logger.error({ err: cardErr, symbol }, "PnL card generation failed");
      }
    }
  })().catch((err) => logger.error({ err }, "close position async error"));
}
