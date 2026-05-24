import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { cancelStopLoss, setTpSl } from "../../services/phoenix/trade.js";
import type { BotContext, PhoenixPosition } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";
import { renderBotError } from "../lib/errors.js";
import { price as fmtPrice, parseAmount, pct, signedUsd, usd } from "../lib/fmt.js";
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

export function validateSlPrice(pos: PhoenixPosition, triggerPrice: number): string | null {
  const mark = Number(pos.markPrice);
  const liq = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);

  if (pos.side === "long") {
    if (triggerPrice >= mark) {
      return `SL for a long must be below the current price (${fmtPrice(mark)}). Enter a lower price.`;
    }
    if (liq > 0 && triggerPrice <= liq) {
      return `That price is at or below your liquidation (${fmtPrice(liq)}). Enter above ${fmtPrice(liq)}.`;
    }
  } else {
    if (triggerPrice <= mark) {
      return `SL for a short must be above the current price (${fmtPrice(mark)}). Enter a higher price.`;
    }
    if (liq > 0 && triggerPrice >= liq) {
      return `That price is at or above your liquidation (${fmtPrice(liq)}). Enter below ${fmtPrice(liq)}.`;
    }
  }
  return null;
}

export function registerSetSl(bot: Bot<BotContext>) {
  bot.command("setsl", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    if (!(await requireActivation(ctx))) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    if (!parts[0]) {
      await ctx.reply("Usage: /setsl <symbol> <price>\nExample: /setsl BTC 45000");
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
      const validationError = validateSlPrice(pos, p);
      if (validationError) {
        await ctx.reply(validationError);
        return;
      }
      await sendSlFinalConfirm(ctx, symbol, p, "market", pos.side);
      return;
    }
    await sendSlPrompt(ctx, symbol, pos.side);
  });

  bot.callbackQuery(/^sl_custom:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];

    const state = await getTraderState(ctx.user.walletAddress);
    const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);
    const markLabel = pos ? fmtPrice(Number(pos.markPrice)) : "—";
    const liqLabel =
      pos?.liquidationPrice === "N/A"
        ? "none"
        : pos?.liquidationPrice
          ? fmtPrice(Number(pos.liquidationPrice))
          : "—";
    const direction = side === "long" ? "below" : "above";

    const msg = fmt`Enter your stop loss price for ${FormattedString.b(symbol)}:\n\nCurrent: ${FormattedString.b(markLabel)}  ·  Liq: ${FormattedString.b(liqLabel)}\nMust be ${direction} current price.\n\nSend ${FormattedString.b("0")} to remove your current stop loss.`;
    await ctx.reply(msg.text, { entities: msg.entities });
    await setPending(ctx.from.id, `editsl:${symbol}:${side}`);
  });

  bot.callbackQuery(/^sl:mode:([A-Z0-9]+):([\d.]+):(market|limit):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, priceStr, mode, side] = ctx.match.slice(1) as [
      string,
      string,
      "market" | "limit",
      "long" | "short",
    ];
    await sendSlFinalConfirm(ctx, symbol, Number(priceStr), mode, side);
  });

  bot.callbackQuery(/^sl:remove:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Removing…");
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    try {
      await cancelStopLoss(
        symbol,
        ctx.user.walletAddress,
        side === "long" ? "long_sl" : "short_sl",
      );
      await ctx.editMessageText(`✅ Stop loss removed for ${symbol}.`);
    } catch (e) {
      logger.error({ err: e, symbol }, "cancelStopLoss failed");
      await renderBotError(ctx, e, { action: "Remove stop loss", edit: true });
    }
  });

  bot.callbackQuery(/^sl:exec:([A-Z0-9]+):([\d.]+):(market|limit):(long|short)$/, async (ctx) => {
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
        slPrice: Number(priceStr),
        slMode: mode,
      });
      const navKb = new InlineKeyboard()
        .text("🎯 Set TP", `edittp:${symbol}:${side}`)
        .row()
        .text("📊 View position", "nav:positions");
      const msg = fmt`✅ ${FormattedString.b("Stop loss set")}\n\n${symbol} — ${fmtPrice(Number(priceStr))}\nYou'll be notified when it triggers.`;
      await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: navKb });
    } catch (e) {
      logger.error({ err: e, symbol, priceStr, mode }, "setTpSl (SL) failed");
      await renderBotError(ctx, e, { action: "Set stop loss", edit: true });
    }
  });
}

export async function sendSlPrompt(
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
  const liqPrice = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);
  const liqLabel = pos.liquidationPrice === "N/A" ? "Safe ✅" : fmtPrice(liqPrice);
  const currentSlLabel = pos.stopLoss ? fmtPrice(Number(pos.stopLoss)) : "—";

  const pcts = [2, 5, 10, 15, 20];
  const kb = new InlineKeyboard();

  for (const p of pcts) {
    const triggerPrice =
      positionSide === "long" ? markPrice * (1 - p / 100) : markPrice * (1 + p / 100);
    const pnl = estimatePnlFromEntry(pos, triggerPrice);
    const sign = positionSide === "long" ? "-" : "+";

    kb.text(
      `${sign}${p}%  →  ${fmtPrice(triggerPrice)}  (${signedUsd(pnl)})`,
      `sl:mode:${symbol}:${priceForCallback(triggerPrice)}:market:${positionSide}`,
    ).row();
  }

  kb.text("Enter price manually →", `sl_custom:${symbol}:${positionSide}`);

  if (pos.stopLoss) {
    kb.row()
      .text("🗑 Clear stop loss", `sl:remove:${symbol}:${positionSide}`)
      .text("✕ Cancel", "cancel");
  } else {
    kb.row().text("✕ Cancel", "cancel");
  }

  const sideLabel = positionSide === "long" ? "LONG" : "SHORT";
  const pnlLine = fmt`${FormattedString.b(signedUsd(unrealizedPnl))} uPnL`;

  const msg = fmt`⛔ ${FormattedString.b(`Stop Loss — ${symbol} ${sideLabel}`)}\n\nEntry       ${FormattedString.b(fmtPrice(entryPrice))}\nMark now  ${FormattedString.b(fmtPrice(markPrice))}  (${pnlLine})\nLiq price   ${FormattedString.b(liqLabel)}\nCurrent SL  ${FormattedString.b(currentSlLabel)}\n\nSelect a stop loss level ${FormattedString.i("(% move  →  trigger price  (est. P&L))")}:`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendSlFinalConfirm(
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
  const liqPrice = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);

  // Validate with the freshly-fetched mark price — catches stale prices from %-buttons tapped after market moves
  const validationError = validateSlPrice(pos, triggerPrice);
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

  let liqBufferLine = fmt``;
  if (liqPrice > 0) {
    const buffer = positionSide === "long" ? triggerPrice - liqPrice : liqPrice - triggerPrice;
    if (buffer > 0) {
      const bufferDir = positionSide === "long" ? "above" : "below";
      liqBufferLine = fmt`\nLiq buffer    ${FormattedString.b(`${usd(buffer)} ${bufferDir} liquidation`)}`;
    }
  }

  const proximity = markPrice > 0 ? Math.abs(triggerPrice - markPrice) / markPrice : 1;
  const proximityWarn =
    proximity < 0.005
      ? fmt`\n\n⚠️ ${FormattedString.b("Warning:")} SL is very close to current price — may trigger immediately.`
      : fmt``;

  const kb = new InlineKeyboard()
    .text(
      "✅ Set stop loss",
      `sl:exec:${symbol}:${priceForCallback(triggerPrice)}:${mode}:${positionSide}`,
    )
    .text("✕ Cancel", "cancel");

  const sideLabel = positionSide === "long" ? "LONG" : "SHORT";
  const msg = fmt`⛔ ${FormattedString.b(`Stop Loss — ${symbol} ${sideLabel}`)}\n\nTrigger      ${FormattedString.b(fmtPrice(triggerPrice))}\nFrom entry   ${FormattedString.b(`${entryPctLabel}  (${signedUsd(pnlFromEntry)} total)`)}  ${FormattedString.i("approx, excl. fees")}\nFrom now     ${FormattedString.b(markPctLabel)}${liqBufferLine}${proximityWarn}\n\nIf triggered: closes position at ~${fmtPrice(triggerPrice)}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendRemoveSlConfirm(
  ctx: BotContext,
  symbol: string,
  positionSide: "long" | "short",
): Promise<void> {
  const kb = new InlineKeyboard()
    .text("✅ Remove stop loss", `sl:remove:${symbol}:${positionSide}`)
    .text("✕ Cancel", "cancel");
  const msg = fmt`Remove stop loss for ${FormattedString.b(symbol)}?`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
