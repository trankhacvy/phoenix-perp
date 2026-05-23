import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { Bot, webhookCallback } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { getMarketSnapshot } from "../services/phoenix/market.js";
import type { BotContext } from "../types/index.js";
import { sendDepositConfirm } from "./commands/deposit.js";
import { registerCommands } from "./commands/index.js";
import { sendLevStep, sendTradeConfirm } from "./commands/long.js";
import { sendPriceAlertConfirm } from "./commands/pricealert.js";
import { sendRemoveSlConfirm, sendSlModePicker } from "./commands/setsl.js";
import { sendRemoveTpConfirm, sendTpModePicker } from "./commands/settp.js";
import { handleAddMonitor } from "./commands/wallet-monitor.js";
import { sendWithdrawConfirm } from "./commands/withdraw.js";
import { renderBotError } from "./lib/errors.js";
import { parseAmount, parseLeverage, usd } from "./lib/fmt.js";
import { clearPending, getPending } from "./lib/pending.js";
import { BASE58_RE } from "./lib/validate.js";
import { actionLogMiddleware } from "./middleware/action-log.js";
import { authMiddleware } from "./middleware/auth.js";
import { orderRateLimitMiddleware, rateLimitMiddleware } from "./middleware/rate-limit.js";

export const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);

bot.use(authMiddleware);
bot.use(actionLogMiddleware);
bot.use(rateLimitMiddleware);

bot.command("long", orderRateLimitMiddleware);
bot.command("short", orderRateLimitMiddleware);

registerCommands(bot);

bot.callbackQuery("noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

bot.on("message:text", async (ctx) => {
  if (!ctx.user) return;

  const pending = await getPending(ctx.from.id);
  if (!pending) return;

  const text = ctx.message.text.trim();
  const parts = pending.split(":");

  if (pending === "withdraw_amount") {
    await clearPending(ctx.from.id);
    const amount = parseAmount(text);
    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount. Try /withdraw again.");
      return;
    }
    await sendWithdrawConfirm(ctx, amount);
    return;
  }

  if (pending === "deposit_amount") {
    await clearPending(ctx.from.id);
    const amount = parseAmount(text);
    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount. Try /deposit again.");
      return;
    }
    await sendDepositConfirm(ctx, amount);
    return;
  }

  if (parts[0] === "trade_size_input") {
    const side = parts[1] as "long" | "short";
    const symbol = parts[2];
    const size = parseAmount(text);
    if (Number.isNaN(size) || size <= 0) {
      await ctx.reply("Invalid amount. Enter a USD value like 100.");
      return;
    }
    await clearPending(ctx.from.id);
    await sendLevStep(ctx, side, symbol, size);
    return;
  }

  if (parts[0] === "trade_lev_input") {
    const side = parts[1] as "long" | "short";
    const symbol = parts[2];
    const amt = Number(parts[3]);
    const lev = parseLeverage(text);
    if (Number.isNaN(lev) || lev < 1 || !Number.isFinite(lev)) {
      await ctx.reply("Invalid leverage. Enter a number like 10 or 2.5 (minimum 1).");
      return;
    }
    const snap = await getMarketSnapshot(symbol).catch(() => null);
    const maxLev = snap?.maxLeverage ?? 100;
    if (lev > maxLev) {
      await ctx.reply(`Max leverage for ${symbol} is ${maxLev}×. Enter between 1–${maxLev}:`);
      return;
    }
    await clearPending(ctx.from.id);
    await sendTradeConfirm(ctx, side, symbol, lev, amt);
    return;
  }

  if (parts[0] === "pricealert") {
    await clearPending(ctx.from.id);
    const symbol = parts[1];
    const triggerPrice = parseAmount(text);
    if (Number.isNaN(triggerPrice) || triggerPrice <= 0) {
      await ctx.reply("Invalid price. Enter a positive number.");
      return;
    }
    await sendPriceAlertConfirm(ctx, symbol, triggerPrice);
    return;
  }

  if (parts[0] === "addmargin") {
    await clearPending(ctx.from.id);
    const symbol = parts[1];
    const amount = parseAmount(text);
    if (Number.isNaN(amount) || amount < 1) {
      await ctx.reply("Minimum margin to add is $1.");
      return;
    }
    const kb = new InlineKeyboard()
      .text(`✅ Add ${usd(amount)}`, `addmargin:exec:${symbol}:${amount}`)
      .text("✕ Cancel", "cancel");
    const confirmMsg = fmt`Add ${FormattedString.b(usd(amount))} margin to ${FormattedString.b(symbol)}?`;
    await ctx.reply(confirmMsg.text, { entities: confirmMsg.entities, reply_markup: kb });
    return;
  }

  if (parts[0] === "editsl") {
    await clearPending(ctx.from.id);
    const symbol = parts[1];
    const positionSide = parts[2] as "long" | "short";
    const triggerPrice = parseAmount(text);
    if (Number.isNaN(triggerPrice) || triggerPrice < 0) {
      await ctx.reply("Invalid price. Enter a positive number, or 0 to remove.");
      return;
    }
    if (triggerPrice === 0) {
      await sendRemoveSlConfirm(ctx, symbol, positionSide);
      return;
    }
    await sendSlModePicker(ctx, symbol, positionSide, triggerPrice);
    return;
  }

  if (parts[0] === "edittp") {
    await clearPending(ctx.from.id);
    const symbol = parts[1];
    const positionSide = parts[2] as "long" | "short";
    const triggerPrice = parseAmount(text);
    if (Number.isNaN(triggerPrice) || triggerPrice < 0) {
      await ctx.reply("Invalid price. Enter a positive number, or 0 to remove.");
      return;
    }
    if (triggerPrice === 0) {
      await sendRemoveTpConfirm(ctx, symbol, positionSide);
      return;
    }
    await sendTpModePicker(ctx, symbol, positionSide, triggerPrice);
    return;
  }

  if (pending === "monitor_add") {
    const address = text.trim();
    if (!BASE58_RE.test(address)) {
      await ctx.reply("Invalid address. Send a valid Solana wallet address.");
      return;
    }
    await clearPending(ctx.from.id);
    await handleAddMonitor(ctx, address);
    return;
  }
});

bot.catch(async (err) => {
  logger.error({ err: err.error, update: err.ctx.update }, "Bot error");
  try {
    await renderBotError(err.ctx, err.error);
  } catch {
    // ctx may be invalid (e.g. callback query already answered)
  }
});

export function handleWebhook() {
  return webhookCallback(bot, "fastify");
}
