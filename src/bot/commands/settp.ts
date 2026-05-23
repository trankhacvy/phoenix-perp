import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { cancelStopLoss, setTpSl } from "../../services/phoenix/trade.js";
import type { BotContext, PhoenixPosition } from "../../types/index.js";
import { renderBotError } from "../lib/errors.js";
import { price as fmtPrice, parseAmount, pct, signedUsd } from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";

function priceForCallback(p: number): string {
  return p.toFixed(8).replace(/\.?0+$/, "");
}

function estimatePnlFromEntry(pos: PhoenixPosition, triggerPrice: number): number {
  const entry = Number(pos.entryPrice);
  const size = Number(pos.size);
  if (Number.isNaN(entry) || Number.isNaN(size) || size === 0) return 0;
  return pos.side === "long" ? (triggerPrice - entry) * size : (entry - triggerPrice) * size;
}

export function validateTpPrice(pos: PhoenixPosition, triggerPrice: number): string | null {
  const mark = Number(pos.markPrice);

  if (pos.side === "long" && triggerPrice <= mark) {
    return `TP for a long must be above the current price (${fmtPrice(mark)}). Enter a higher price.`;
  }
  if (pos.side === "short" && triggerPrice >= mark) {
    return `TP for a short must be below the current price (${fmtPrice(mark)}). Enter a lower price.`;
  }
  return null;
}

export function registerSetTp(bot: Bot<BotContext>) {
  bot.command("settp", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    if (!parts[0]) {
      await ctx.reply("Usage: /settp <symbol> <price>\nExample: /settp BTC 55000");
      return;
    }
    const symbol = parts[0].toUpperCase();
    const state = await getTraderState(ctx.user.walletAddress);
    const matches = state.positions.filter((p) => p.symbol === symbol);
    if (matches.length === 0) {
      await ctx.reply(`No open ${symbol} position found.`);
      return;
    }
    if (matches.length > 1) {
      await ctx.reply(`You have multiple ${symbol} positions. Use /positions to manage them.`);
      return;
    }
    const pos = matches[0];
    if (parts.length >= 2) {
      const p = parseAmount(parts[1]);
      if (Number.isNaN(p)) {
        await ctx.reply("Invalid price.");
        return;
      }
      const validationError = validateTpPrice(pos, p);
      if (validationError) {
        await ctx.reply(validationError);
        return;
      }
      await sendTpFinalConfirm(ctx, symbol, p, "limit", pos.side);
      return;
    }
    await sendTpPrompt(ctx, symbol, pos.side);
  });

  bot.callbackQuery(/^tp_custom:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];

    const state = await getTraderState(ctx.user.walletAddress);
    const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);
    const markLabel = pos ? fmtPrice(Number(pos.markPrice)) : "—";
    const direction = side === "long" ? "above" : "below";

    const msg = fmt`Enter your take profit price for ${FormattedString.b(symbol)}:\n\nCurrent: ${FormattedString.b(markLabel)}\nMust be ${direction} current price.\n\nSend ${FormattedString.b("0")} to remove your current take profit.`;
    await ctx.reply(msg.text, { entities: msg.entities });
    await setPending(ctx.from.id, `edittp:${symbol}:${side}`);
  });

  bot.callbackQuery(/^tp:mode:([A-Z0-9]+):([\d.]+):(market|limit):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, priceStr, mode, side] = ctx.match.slice(1) as [
      string,
      string,
      "market" | "limit",
      "long" | "short",
    ];
    await sendTpFinalConfirm(ctx, symbol, Number(priceStr), mode, side);
  });

  bot.callbackQuery(/^tp:remove:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Removing…");
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    try {
      await cancelStopLoss(
        symbol,
        ctx.user.walletAddress,
        side === "long" ? "long_tp" : "short_tp",
      );
      await ctx.editMessageText(`✅ Take profit removed for ${symbol}.`);
    } catch (e) {
      logger.error({ err: e, symbol }, "cancelStopLoss (TP) failed");
      await renderBotError(ctx, e, { action: "Remove take profit", edit: true });
    }
  });

  bot.callbackQuery(/^tp:exec:([A-Z0-9]+):([\d.]+):(market|limit):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Setting…");
    if (!ctx.user) return;
    const [symbol, priceStr, mode, side] = ctx.match.slice(1) as [
      string,
      string,
      "market" | "limit",
      "long" | "short",
    ];
    try {
      await setTpSl({
        symbol,
        walletAddress: ctx.user.walletAddress,
        positionSide: side,
        tpPrice: Number(priceStr),
        tpMode: mode,
      });
      const msg = fmt`✅ ${FormattedString.b("Take profit set")}\n\n${symbol} — ${fmtPrice(Number(priceStr))}\nYou'll be notified when it triggers.`;
      await ctx.editMessageText(msg.text, { entities: msg.entities });
    } catch (e) {
      logger.error({ err: e, symbol, priceStr, mode }, "setTpSl (TP) failed");
      await renderBotError(ctx, e, { action: "Set take profit", edit: true });
    }
  });
}

export async function sendTpPrompt(
  ctx: BotContext,
  symbol: string,
  positionSide: "long" | "short",
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === positionSide);
  if (!pos) {
    await ctx.reply(`No open ${symbol} ${positionSide} position found.`);
    return;
  }

  const markPrice = Number(pos.markPrice);
  const entryPrice = Number(pos.entryPrice);
  const unrealizedPnl = Number(pos.unrealizedPnl);
  const currentTpLabel = pos.takeProfit ? fmtPrice(Number(pos.takeProfit)) : "—";

  const pcts = [5, 10, 20, 30, 50];
  const kb = new InlineKeyboard();

  for (let i = 0; i < pcts.length; i++) {
    const p = pcts[i];
    const triggerPrice =
      positionSide === "long" ? markPrice * (1 + p / 100) : markPrice * (1 - p / 100);
    const pnl = estimatePnlFromEntry(pos, triggerPrice);
    const sign = positionSide === "long" ? "+" : "-";

    kb.text(
      `${sign}${p}%  ${fmtPrice(triggerPrice)}  ${signedUsd(pnl)}`,
      `tp:mode:${symbol}:${priceForCallback(triggerPrice)}:limit:${positionSide}`,
    );
    if (i === 1 || i === 3) kb.row();
  }

  kb.row().text("Enter price manually →", `tp_custom:${symbol}:${positionSide}`);

  if (pos.takeProfit) {
    kb.row()
      .text("🗑 Clear take profit", `tp:remove:${symbol}:${positionSide}`)
      .text("✕ Cancel", "cancel");
  } else {
    kb.row().text("✕ Cancel", "cancel");
  }

  const sideLabel = positionSide === "long" ? "LONG" : "SHORT";
  const pnlLine = fmt`${FormattedString.b(signedUsd(unrealizedPnl))} uPnL`;

  const msg = fmt`🎯 ${FormattedString.b(`Take Profit — ${symbol} ${sideLabel}`)}\n\nEntry       ${FormattedString.b(fmtPrice(entryPrice))}\nMark now  ${FormattedString.b(fmtPrice(markPrice))}  (${pnlLine})\nCurrent TP  ${FormattedString.b(currentTpLabel)}\n\nSelect a take profit level:`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendTpFinalConfirm(
  ctx: BotContext,
  symbol: string,
  triggerPrice: number,
  mode: "market" | "limit",
  positionSide: "long" | "short",
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === positionSide);

  if (!pos) {
    await ctx.reply(`No open ${symbol} ${positionSide} position. It may have been closed.`);
    return;
  }

  const markPrice = Number(pos.markPrice);
  const entryPrice = Number(pos.entryPrice);

  // Validate with the freshly-fetched mark price — catches stale prices from %-buttons tapped after market moves
  const validationError = validateTpPrice(pos, triggerPrice);
  if (validationError) {
    const kb = new InlineKeyboard().text("✕ Dismiss", "cancel");
    await ctx.reply(`${validationError}\n\nPrice may have moved since the menu was shown.`, {
      reply_markup: kb,
    });
    return;
  }

  const pnlFromEntry = estimatePnlFromEntry(pos, triggerPrice);

  // Normalize sign to P&L perspective: positive = profit for this side
  const rawEntryPct = entryPrice > 0 ? ((triggerPrice - entryPrice) / entryPrice) * 100 : null;
  const entryPct =
    rawEntryPct !== null ? (positionSide === "long" ? rawEntryPct : -rawEntryPct) : null;
  const entryPctLabel = entryPct !== null ? pct(entryPct) : "—";

  const markPct = markPrice > 0 ? ((triggerPrice - markPrice) / markPrice) * 100 : null;
  const markPctLabel = markPct !== null ? pct(markPct) : "—";

  const execLabel = pnlFromEntry >= 0 ? "✅ Lock in profit" : "✅ Set take profit";

  const fillNote =
    mode === "limit"
      ? fmt`\nOrder placed at ${FormattedString.b(fmtPrice(triggerPrice))} — fills when price reaches it.`
      : fmt`\nCloses immediately when price reaches ${FormattedString.b(fmtPrice(triggerPrice))}.`;

  const kb = new InlineKeyboard()
    .text(execLabel, `tp:exec:${symbol}:${priceForCallback(triggerPrice)}:${mode}:${positionSide}`)
    .text("✕ Cancel", "cancel");

  const sideLabel = positionSide === "long" ? "LONG" : "SHORT";
  const msg = fmt`🎯 ${FormattedString.b(`Take Profit — ${symbol} ${sideLabel}`)}\n\nTrigger      ${FormattedString.b(fmtPrice(triggerPrice))}\nFrom entry   ${FormattedString.b(`${entryPctLabel}  (${signedUsd(pnlFromEntry)} total)`)}  ${FormattedString.i("approx, excl. fees")}\nFrom now     ${FormattedString.b(markPctLabel)}${fillNote}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendRemoveTpConfirm(
  ctx: BotContext,
  symbol: string,
  positionSide: "long" | "short",
): Promise<void> {
  const kb = new InlineKeyboard()
    .text("✅ Remove take profit", `tp:remove:${symbol}:${positionSide}`)
    .text("✕ Cancel", "cancel");
  const msg = fmt`Remove take profit for ${FormattedString.b(symbol)}?`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
