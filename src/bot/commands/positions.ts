import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { InlineKeyboard, InputFile } from "grammy";
import type { Bot } from "grammy";
import { logger } from "../../lib/logger.js";
import { generatePnlCard } from "../../services/image.js";
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
import { toBotError } from "../lib/errors.js";
import {
  cryptoSize,
  price as fmtPrice,
  num,
  pct,
  pnlEmoji,
  signedUsd,
  solscanUrl,
  usd,
} from "../lib/fmt.js";
import { claimIdempotencyKey } from "../lib/idempotent.js";
import { setPending } from "../lib/pending.js";
import { checkOrderRateLimit } from "../middleware/rate-limit.js";
import { sendSlPrompt } from "./setsl.js";
import { sendTpPrompt } from "./settp.js";

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

function buildDetailText(pos: PhoenixPosition, unsettledFunding: number): FormattedString {
  const upnl = Number(pos.unrealizedPnl);
  const upnlPct = calcPnlPct(pos);
  const sideLabel = pos.side === "long" ? "LONG" : "SHORT";
  const levLabel = pos.leverage ? ` · ${pos.leverage}x` : "";
  const marginLabel = pos.marginMode === "cross" ? "Cross" : "Isolated";
  const posValue = Number(pos.markPrice) * Number(pos.size);
  const pnlStr = upnlPct != null ? `${signedUsd(upnl)}  (${pct(upnlPct)})` : signedUsd(upnl);
  const liq = formatLiqValue(pos);
  const liqLine = fmt`${FormattedString.b(liq.text)}${liq.warn ? " ⚠️" : ""}`;

  const tpStr = pos.takeProfit ? fmtPrice(Number(pos.takeProfit)) : "—";
  const slStr = pos.stopLoss ? fmtPrice(Number(pos.stopLoss)) : "—";

  const lines: FormattedString[] = [
    fmt`${FormattedString.b(`${pos.symbol} · ${sideLabel}${levLabel}`)}  (${marginLabel})`,
    fmt`━━━━━━━━━━━━━━━━━━━━━━━━━`,
    fmt`Unrealized PnL   ${FormattedString.b(pnlStr)} ${pnlEmoji(upnl)}`,
    fmt``,
    fmt`Position size   ${FormattedString.b(`${cryptoSize(Number(pos.size), pos.symbol)}  (${usd(posValue)})`)}`,
    fmt`Entry price   ${FormattedString.b(fmtPrice(Number(pos.entryPrice)))}`,
    fmt`Mark price   ${FormattedString.b(fmtPrice(Number(pos.markPrice)))}`,
    fmt`Liq. price   ${liqLine}`,
    fmt``,
    fmt`Take profit   ${FormattedString.b(tpStr)}`,
    fmt`Stop loss     ${FormattedString.b(slStr)}`,
  ];

  if (Math.abs(unsettledFunding) > 0.001) {
    lines.push(fmt`Funding   ${FormattedString.b(signedUsd(unsettledFunding))}`);
  }

  return FormattedString.join(lines, "\n");
}

export async function sendPositionDetail(
  ctx: BotContext,
  symbol: string,
  side: "long" | "short",
  edit = false,
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
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

  const unsettledFunding = Number(state.unsettledFunding);
  const msg = buildDetailText(pos, unsettledFunding);
  const kb = positionKeyboard(symbol, side);

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: kb,
    });
  } else {
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
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

    await ctx.editMessageText("⏳ Adding margin…");

    const user = ctx.user;
    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    const api = ctx.api;

    if (!chatId || !msgId) return;

    (async () => {
      try {
        const s = await getSettings(user.id);
        const marginFee = getFeeConfig(s.feeMode, s.customFeeSol);
        await addMargin(symbol, user.walletAddress, amount, marginFee);
        const doneMsg = fmt`✅ Added ${FormattedString.b(usd(amount))} margin to ${FormattedString.b(symbol)}.`;
        await api.editMessageText(chatId, msgId, doneMsg.text, {
          entities: doneMsg.entities,
        });
      } catch (e) {
        logger.error({ err: e, symbol, amount }, "addMargin failed");
        const be = toBotError(e);
        const hintLine = be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``;
        const retryLine = be.retryable ? fmt`\n\n↩️ ${FormattedString.i("Safe to retry.")}` : fmt``;
        const errorText = fmt`${FormattedString.b("❌ Add margin failed")}\n\n${be.userMessage}${hintLine}${retryLine}`;
        try {
          await api.editMessageText(chatId, msgId, errorText.text, {
            entities: errorText.entities,
          });
        } catch (editErr) {
          logger.warn({ err: editErr }, "failed to edit error message after addMargin failure");
        }
      }
    })().catch((err) => logger.error({ err }, "add margin async error"));
  });

  // SL/TP edit callbacks
  bot.callbackQuery(/^editsl:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    await sendSlPrompt(ctx, symbol, side);
  });

  bot.callbackQuery(/^edittp:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    await sendTpPrompt(ctx, symbol, side);
  });
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

  if (ctx.callbackQuery) {
    await ctx.editMessageText("⏳ Closing position…");
  } else {
    await ctx.reply("⏳ Closing position…");
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
      const be = toBotError(e);
      const hintLine = be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``;
      const retryLine = be.retryable ? fmt`\n\n↩️ ${FormattedString.i("Safe to retry.")}` : fmt``;
      const errorText = fmt`${FormattedString.b("❌ Close position failed")}\n\n${be.userMessage}${hintLine}${retryLine}`;
      try {
        await api.editMessageText(chatId, msgId, errorText.text, {
          entities: errorText.entities,
          reply_markup: kb,
        });
      } catch (editErr) {
        logger.warn({ err: editErr }, "failed to edit error message after close failure");
      }
      return;
    }

    const state = await getTraderState(user.walletAddress).catch(() => null);
    const pos = state?.positions.find((p) => p.symbol === symbol && p.side === side);

    if (pos) {
      const markPrice = Number(pos.markPrice);
      const totalSize = Number(pos.size);
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
    const successMsg = fmt`✅ ${FormattedString.b("Position closed")}\n\n${symbol} — ${FormattedString.b(closedLabel)}\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}`;
    try {
      await api.editMessageText(chatId, msgId, successMsg.text, {
        entities: successMsg.entities,
        reply_markup: afterKb,
        link_preview_options: { is_disabled: true },
      });
    } catch (editErr) {
      logger.warn(
        { err: editErr, symbol, sig },
        "editMessageText failed after closePosition succeeded",
      );
    }

    if (pos) {
      try {
        const pnl = Number(pos.unrealizedPnl) * fraction;
        const leverage = pos.leverage ?? 1;
        const margin = (Number(pos.entryPrice) * Number(pos.size)) / Math.max(leverage, 1);
        const roiPct = margin > 0 ? ((pnl / margin) * 100).toFixed(2) : "0.00";
        const card = await generatePnlCard({
          symbol,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: pos.markPrice,
          roiPercent: Number(roiPct),
          pnlUsdc: pnl,
        });
        await api.sendPhoto(chatId, new InputFile(card, "pnl.png"));
      } catch (cardErr) {
        logger.error({ err: cardErr, symbol }, "PnL card generation failed");
      }
    }
  })().catch((err) => logger.error({ err }, "close position async error"));
}
