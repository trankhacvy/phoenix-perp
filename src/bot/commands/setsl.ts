import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { cancelStopLoss, setTpSl } from "../../services/phoenix/trade.js";
import { getKitSigner } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { renderBotError } from "../lib/errors.js";
import { price as fmtPrice, parseAmount, usd } from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";

export function registerSetSl(bot: Bot<BotContext>) {
  bot.command("setsl", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    if (!parts[0]) {
      await ctx.reply("Usage: /setsl <symbol> <price> [market|limit]\nExample: /setsl BTC 45000");
      return;
    }
    const symbol = parts[0].toUpperCase();
    const state = await getTraderState(ctx.user.walletAddress);
    const pos = state.positions.find((p) => p.symbol === symbol);
    if (!pos) {
      await ctx.reply(`No open ${symbol} position found.`);
      return;
    }
    if (parts.length >= 2) {
      const p = parseAmount(parts[1]);
      if (Number.isNaN(p)) {
        await ctx.reply("Invalid price.");
        return;
      }
      const mode = parts[2] === "limit" ? "limit" : "market";
      const markPrice = Number(pos.markPrice);
      if (pos.side === "long" && p >= markPrice) {
        await ctx.reply(
          `Stop loss for a long must be below current price (${fmtPrice(markPrice)}).`,
        );
        return;
      }
      if (pos.side === "short" && p <= markPrice) {
        await ctx.reply(
          `Stop loss for a short must be above current price (${fmtPrice(markPrice)}).`,
        );
        return;
      }
      await sendSlFinalConfirm(ctx, symbol, p, mode, pos.side);
      return;
    }
    await sendSlPrompt(ctx, symbol, pos.side);
  });

  bot.callbackQuery(/^sl_custom:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    const msg = fmt`Enter your stop loss price for ${FormattedString.b(symbol)}:\n\nSend ${FormattedString.b("0")} to remove your current stop loss.`;
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
        getKitSigner(ctx.user.walletAddress),
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
      await setTpSl(
        {
          symbol,
          walletAddress: ctx.user.walletAddress,
          positionSide: side,
          slPrice: Number(priceStr),
          slMode: mode,
        },
        getKitSigner(ctx.user.walletAddress),
      );
      const msg = fmt`✅ ${FormattedString.b("Stop loss set")}\n\n${symbol} — ${fmtPrice(Number(priceStr))}\nYou'll be notified when it triggers.`;
      await ctx.editMessageText(msg.text, { entities: msg.entities });
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
  const pos = state.positions.find((p) => p.symbol === symbol);
  if (!pos) {
    await ctx.reply(`No open ${symbol} position found.`);
    return;
  }

  const markPrice = Number(pos.markPrice);
  const liqPrice = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);
  const liqLabel = pos.liquidationPrice === "N/A" ? "None" : fmtPrice(liqPrice);
  const direction = positionSide === "long" ? "below" : "above";

  const pcts = [2, 5, 10, 15, 20];
  const kb = new InlineKeyboard();
  for (let i = 0; i < pcts.length; i++) {
    const pct = pcts[i];
    const triggerPrice =
      positionSide === "long" ? markPrice * (1 - pct / 100) : markPrice * (1 + pct / 100);
    const sign = positionSide === "long" ? "-" : "+";
    kb.text(
      `${sign}${pct}%  ${fmtPrice(triggerPrice)}`,
      `sl:mode:${symbol}:${triggerPrice.toFixed(4)}:market:${positionSide}`,
    );
    if (i === 1 || i === 3) kb.row();
  }
  kb.row()
    .text("Custom price", `sl_custom:${symbol}:${positionSide}`)
    .row()
    .text("🗑 Remove stop loss", `sl:remove:${symbol}:${positionSide}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`🛑 ${FormattedString.b(`Set Stop Loss — ${symbol}`)}\n\nCurrent price   ${FormattedString.b(fmtPrice(markPrice))}\nLiquidation at  ${FormattedString.b(liqLabel)}\n\nSelect a level (${direction} current price):`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendSlModePicker(
  ctx: BotContext,
  symbol: string,
  positionSide: "long" | "short",
  triggerPrice: number,
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol);
  if (!pos) {
    await ctx.reply(`No open ${symbol} position found.`);
    return;
  }

  const markPrice = Number(pos.markPrice);
  const liqPrice = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);

  if (positionSide === "long") {
    if (triggerPrice >= markPrice) {
      await ctx.reply(
        `Stop loss must be below the current price (${fmtPrice(markPrice)}). Enter a lower price.`,
      );
      return;
    }
    if (liqPrice > 0 && triggerPrice <= liqPrice) {
      await ctx.reply(
        `That price is at or below your liquidation price (${fmtPrice(liqPrice)}). Enter a higher price.`,
      );
      return;
    }
  } else {
    if (triggerPrice <= markPrice) {
      await ctx.reply(
        `Stop loss must be above the current price (${fmtPrice(markPrice)}). Enter a higher price.`,
      );
      return;
    }
    if (liqPrice > 0 && triggerPrice >= liqPrice) {
      await ctx.reply(
        `That price is at or above your liquidation price (${fmtPrice(liqPrice)}). Enter a lower price.`,
      );
      return;
    }
  }

  const proximity = Math.abs(triggerPrice - markPrice) / markPrice;
  const proximityWarn =
    proximity < 0.005
      ? fmt`\n⚠️ That stop is very close to the current price and could trigger immediately.`
      : fmt``;

  const kb = new InlineKeyboard()
    .text("Market (recommended)", `sl:mode:${symbol}:${triggerPrice}:market:${positionSide}`)
    .row()
    .text("Limit", `sl:mode:${symbol}:${triggerPrice}:limit:${positionSide}`)
    .row()
    .text("✕ Cancel", "cancel");

  const msg = fmt`Stop loss at ${FormattedString.b(fmtPrice(triggerPrice))}${proximityWarn}\n\n${FormattedString.b("Market")} — Close immediately at best available price\n           (may fill slightly past ${fmtPrice(triggerPrice)})\n\n${FormattedString.b("Limit")}  — Place a sell order at exactly ${fmtPrice(triggerPrice)}\n           (may not fill if price moves through quickly)`;
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

async function sendSlFinalConfirm(
  ctx: BotContext,
  symbol: string,
  triggerPrice: number,
  mode: "market" | "limit",
  positionSide: "long" | "short",
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol);
  const fromEntry = pos ? Math.abs(Number(pos.entryPrice) - triggerPrice) * Number(pos.size) : null;
  const lossStr =
    fromEntry !== null
      ? fmt`\nMax loss from entry: ${FormattedString.code(`-${usd(fromEntry)}`)}`
      : fmt``;

  const kb = new InlineKeyboard()
    .text("✅ Set stop loss", `sl:exec:${symbol}:${triggerPrice}:${mode}:${positionSide}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`Set stop loss?\n\n${FormattedString.b(symbol)} — ${fmtPrice(triggerPrice)} (${mode === "market" ? "Market" : "Limit"})${lossStr}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
