import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { Bot, webhookCallback } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import type { BotContext } from "../types/index.js";
import { registerCommands } from "./commands/index.js";
import { sendDepositConfirm } from "./commands/deposit.js";
import { sendSizePicker, sendTradeConfirm } from "./commands/long.js";
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

  await clearPending(ctx.from.id);

  const text = ctx.message.text.trim();
  const parts = pending.split(":");

  if (pending === "withdraw_amount") {
    const amount = parseAmount(text);
    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount. Try /withdraw again.");
      return;
    }
    await sendWithdrawConfirm(ctx, amount);
    return;
  }

  if (pending === "deposit_amount") {
    const amount = parseAmount(text);
    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount. Try /deposit again.");
      return;
    }
    await sendDepositConfirm(ctx, amount);
    return;
  }

  if (parts[0] === "trade_leverage") {
    const side = parts[1] as "long" | "short";
    const symbol = parts[2];
    const lev = parseLeverage(text);
    if (Number.isNaN(lev) || lev < 1) {
      await ctx.reply("Invalid leverage. Enter a number like 10 or 10x.");
      return;
    }
    await sendSizePicker(ctx, side, symbol, lev);
    return;
  }

  if (parts[0] === "trade_size") {
    const side = parts[1] as "long" | "short";
    const symbol = parts[2];
    const lev = Number(parts[3]);
    const size = parseAmount(text);
    if (Number.isNaN(size) || size <= 0) {
      await ctx.reply("Invalid amount. Enter a USD value like 500.");
      return;
    }
    await sendTradeConfirm(ctx, side, symbol, lev, size);
    return;
  }

  if (parts[0] === "pricealert") {
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
