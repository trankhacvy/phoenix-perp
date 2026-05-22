import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { cancelStopLoss, setTpSl } from "../../services/phoenix/trade.js";
import { getKitSigner } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { price as fmtPrice, parseAmount, usd } from "../lib/fmt.js";
import { formatTradeError } from "../lib/errors.js";
import { setPending } from "../lib/pending.js";

const LADDER_FRACTIONS = [0.25, 0.5, 1.0];

export function registerSetTp(bot: Bot<BotContext>) {
  bot.command("settp", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    if (!parts[0]) {
      await ctx.reply("Usage: /settp <symbol> <price> [market|limit]\nExample: /settp BTC 55000");
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
      if (pos.side === "long" && p <= markPrice) {
        await ctx.reply(
          `Take profit for a long must be above current price (${fmtPrice(markPrice)}).`,
        );
        return;
      }
      if (pos.side === "short" && p >= markPrice) {
        await ctx.reply(
          `Take profit for a short must be below current price (${fmtPrice(markPrice)}).`,
        );
        return;
      }
      await sendTpFinalConfirm(ctx, symbol, p, mode, pos.side);
      return;
    }
    await sendTpPrompt(ctx, symbol, pos.side);
  });

  bot.callbackQuery(/^tp_custom:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    const msg = fmt`Enter your take profit price for ${FormattedString.b(symbol)}:\n\nSend ${FormattedString.b("0")} to remove your current take profit.`;
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
        getKitSigner(ctx.user.walletAddress),
      );
      await ctx.editMessageText(`✅ Take profit removed for ${symbol}.`);
    } catch (e) {
      logger.error({ err: e, symbol }, "cancelStopLoss (TP) failed");
      await ctx.editMessageText(formatTradeError(e, "Remove take profit"), { parse_mode: "HTML" });
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
      await setTpSl(
        {
          symbol,
          walletAddress: ctx.user.walletAddress,
          positionSide: side,
          tpPrice: Number(priceStr),
          tpMode: mode,
        },
        getKitSigner(ctx.user.walletAddress),
      );
      const msg = fmt`✅ ${FormattedString.b("Take profit set")}\n\n${symbol} — ${fmtPrice(Number(priceStr))}\nYou'll be notified when it triggers.`;
      await ctx.editMessageText(msg.text, { entities: msg.entities });
    } catch (e) {
      logger.error({ err: e, symbol, priceStr, mode }, "setTpSl (TP) failed");
      await ctx.editMessageText(formatTradeError(e, "Set take profit"), { parse_mode: "HTML" });
    }
  });

  bot.callbackQuery(/^tp_ladder:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    const state = await getTraderState(ctx.user.walletAddress);
    const pos = state.positions.find((p) => p.symbol === symbol);
    if (!pos) {
      await ctx.reply(`No open ${symbol} position.`);
      return;
    }

    const markPrice = Number(pos.markPrice);
    const pcts = [5, 10, 20];
    const levels = pcts.map((pct, i) => ({
      price: side === "long" ? markPrice * (1 + pct / 100) : markPrice * (1 - pct / 100),
      fraction: LADDER_FRACTIONS[i],
      pct,
    }));

    const lines = levels
      .map(
        (l) =>
          `• ${side === "long" ? "+" : "-"}${l.pct}%  ~${fmtPrice(l.price)}  close ${(l.fraction * 100).toFixed(0)}%`,
      )
      .join("\n");

    const pricesParam = levels.map((l) => l.price.toFixed(2)).join(",");
    const kb = new InlineKeyboard()
      .text("✅ Set ladder", `tp_ladder_exec:${symbol}:${side}:${pricesParam}`)
      .text("✕ Cancel", "cancel");

    const msg = fmt`🪜 ${FormattedString.b(`Ladder Take Profit — ${symbol}`)}\n\n${lines}\n\n${FormattedString.i("Each level closes a portion of your position.")}`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^tp_ladder_exec:([A-Z0-9]+):(long|short):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Setting ladder…");
    if (!ctx.user) return;
    const [symbol, side, pricesStr] = ctx.match.slice(1) as [string, "long" | "short", string];
    const prices = pricesStr.split(",").map(Number);

    try {
      await setTpSl(
        {
          symbol,
          walletAddress: ctx.user.walletAddress,
          positionSide: side,
          tpLevels: prices.map((p, i) => ({
            price: p,
            fraction: LADDER_FRACTIONS[i],
            mode: "limit" as const,
          })),
        },
        getKitSigner(ctx.user.walletAddress),
      );
      const msg = fmt`✅ ${FormattedString.b("Ladder take profit set")}\n\n${symbol} — ${prices.length} levels active`;
      await ctx.editMessageText(msg.text, { entities: msg.entities });
    } catch (e) {
      logger.error({ err: e, symbol }, "tp_ladder_exec failed");
      await ctx.editMessageText(formatTradeError(e, "Ladder TP"), { parse_mode: "HTML" });
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
  const pos = state.positions.find((p) => p.symbol === symbol);
  if (!pos) {
    await ctx.reply(`No open ${symbol} position found.`);
    return;
  }

  const markPrice = Number(pos.markPrice);
  const direction = positionSide === "long" ? "above" : "below";

  const pcts = [5, 10, 20, 30, 50];
  const kb = new InlineKeyboard();
  for (let i = 0; i < pcts.length; i++) {
    const pct = pcts[i];
    const triggerPrice =
      positionSide === "long" ? markPrice * (1 + pct / 100) : markPrice * (1 - pct / 100);
    const sign = positionSide === "long" ? "+" : "-";
    kb.text(
      `${sign}${pct}%  ${fmtPrice(triggerPrice)}`,
      `tp:mode:${symbol}:${triggerPrice.toFixed(4)}:limit:${positionSide}`,
    );
    if (i === 1 || i === 3) kb.row();
  }
  kb.row()
    .text("Custom price", `tp_custom:${symbol}:${positionSide}`)
    .row()
    .text("🪜 Ladder exit (25/50/100%)", `tp_ladder:${symbol}:${positionSide}`)
    .row()
    .text("🗑 Remove take profit", `tp:remove:${symbol}:${positionSide}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`🎯 ${FormattedString.b(`Set Take Profit — ${symbol}`)}\n\nCurrent price  ${FormattedString.b(fmtPrice(markPrice))}\nEntry price    ${FormattedString.b(fmtPrice(Number(pos.entryPrice)))}\n\nSelect a level (${direction} current price):`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendTpModePicker(
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

  if (positionSide === "long" && triggerPrice <= markPrice) {
    await ctx.reply(
      `Take profit must be above the current price (${fmtPrice(markPrice)}). Enter a higher price.`,
    );
    return;
  }
  if (positionSide === "short" && triggerPrice >= markPrice) {
    await ctx.reply(
      `Take profit must be below the current price (${fmtPrice(markPrice)}). Enter a lower price.`,
    );
    return;
  }

  const expectedGain = Math.abs(triggerPrice - Number(pos.entryPrice)) * Number(pos.size);

  const kb = new InlineKeyboard()
    .text("Limit (recommended)", `tp:mode:${symbol}:${triggerPrice}:limit:${positionSide}`)
    .row()
    .text("Market", `tp:mode:${symbol}:${triggerPrice}:market:${positionSide}`)
    .row()
    .text("✕ Cancel", "cancel");

  const msg = fmt`Take profit at ${FormattedString.b(fmtPrice(triggerPrice))}\nExpected gain: ${FormattedString.code(`+${usd(expectedGain)}`)}\n\n${FormattedString.b("Limit")}  — Place an order at exactly ${fmtPrice(triggerPrice)}\n${FormattedString.b("Market")} — Close immediately when price hits`;
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

async function sendTpFinalConfirm(
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
  const gainStr =
    fromEntry !== null
      ? fmt`\nExpected gain: ${FormattedString.code(`+${usd(fromEntry)}`)}`
      : fmt``;

  const kb = new InlineKeyboard()
    .text("✅ Set take profit", `tp:exec:${symbol}:${triggerPrice}:${mode}:${positionSide}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`Set take profit?\n\n${FormattedString.b(symbol)} — ${fmtPrice(triggerPrice)} (${mode === "market" ? "Market" : "Limit"})${gainStr}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
