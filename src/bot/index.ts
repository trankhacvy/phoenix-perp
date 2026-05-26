import { autoRetry } from "@grammyjs/auto-retry";
import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { sequentialize } from "@grammyjs/runner";
import { Bot, GrammyError, HttpError, webhookCallback } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { getMarketSnapshot } from "../services/phoenix/market.js";
import { getWalletUsdcBalance } from "../services/wallet.js";
import type { BotContext } from "../types/index.js";
import { sendDepositConfirm } from "./commands/deposit.js";
import { registerCommands } from "./commands/index.js";
import { sendLevStep, sendTradeConfirm } from "./commands/long.js";
import { sendPriceAlertConfirm } from "./commands/pricealert.js";
import { handleTpSlPriceInput, handleTpSlSizeInput } from "./commands/tpsl.js";
import { handleAddMonitor } from "./commands/wallet-monitor.js";
import {
  getWithdrawBalances,
  sendWithdrawAddrStep,
  sendWithdrawConfirmExternal,
  sendWithdrawConfirmInternal,
} from "./commands/withdraw.js";
import { renderBotError } from "./lib/errors.js";
import { parseAmount, parseLeverage, usd } from "./lib/fmt.js";
import { clearPending, getPending } from "./lib/pending.js";
import { BASE58_RE } from "./lib/validate.js";
import { actionLogMiddleware } from "./middleware/action-log.js";
import { authMiddleware } from "./middleware/auth.js";
import { orderRateLimitMiddleware, rateLimitMiddleware } from "./middleware/rate-limit.js";

export const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);

bot.api.config.use(
  autoRetry({
    maxRetryAttempts: 2,
    maxDelaySeconds: 5,
  }),
);

function getSessionKey(ctx: BotContext): string | undefined {
  return ctx.from?.id.toString();
}

bot.use(sequentialize(getSessionKey));

bot.use(rateLimitMiddleware);
bot.use(authMiddleware);
bot.use(actionLogMiddleware);

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

  if (pending === "withdraw_custom:internal" || pending === "withdraw_custom:external") {
    const amount = parseAmount(text);
    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount. Enter a positive number like 50.");
      return;
    }
    const { deposited } = await getWithdrawBalances(ctx.user.walletAddress);
    if (amount > deposited + 0.01) {
      await ctx.reply(
        `You only have ${usd(deposited)} in your trading account. Enter a smaller amount.`,
      );
      return;
    }
    await clearPending(ctx.from.id);
    if (pending === "withdraw_custom:internal") {
      await sendWithdrawConfirmInternal(ctx, amount);
    } else {
      await sendWithdrawAddrStep(ctx, amount, "trading");
    }
    return;
  }

  if (pending === "withdraw_custom:wallet") {
    const amount = parseAmount(text);
    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount. Enter a positive number like 50.");
      return;
    }
    const { walletUsdc } = await getWithdrawBalances(ctx.user.walletAddress);
    if (amount > walletUsdc + 0.01) {
      await ctx.reply(
        `You only have ${usd(walletUsdc)} USDC in your bot wallet. Enter a smaller amount.`,
      );
      return;
    }
    await clearPending(ctx.from.id);
    await sendWithdrawAddrStep(ctx, amount, "wallet");
    return;
  }

  if (parts[0] === "withdraw_ext_addr") {
    const amount = Number(parts[1]);
    const source = (parts[2] === "wallet" ? "wallet" : "trading") as "wallet" | "trading";
    const address = text.trim();
    if (!BASE58_RE.test(address)) {
      await ctx.reply("Invalid Solana address. Send a valid base58 address.");
      return;
    }
    await clearPending(ctx.from.id);
    await sendWithdrawConfirmExternal(ctx, amount, address, source);
    return;
  }

  if (pending === "deposit_amount") {
    const amount = parseAmount(text);
    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount. Enter a positive number like 50.");
      return;
    }
    const walletUsdc = await getWalletUsdcBalance(ctx.user.walletAddress).catch(() => 0);
    if (amount > walletUsdc + 0.01) {
      await ctx.reply(
        `You only have ${usd(walletUsdc)} USDC in your wallet. Enter a smaller amount.`,
      );
      return;
    }
    await clearPending(ctx.from.id);
    await sendDepositConfirm(ctx, amount);
    return;
  }

  if (pending === "settings_custom_fee") {
    await clearPending(ctx.from.id);
    const val = parseAmount(text);
    if (Number.isNaN(val) || val <= 0 || val > 1) {
      await ctx.reply("Invalid amount. Enter between 0.0001 and 1 SOL.");
      return;
    }
    const { saveSettings } = await import("../services/settings.js");
    await saveSettings(ctx.user.id, { feeMode: "custom", customFeeSol: val });
    await ctx.reply(`✅ Priority fee set to ${val} SOL`);
    return;
  }

  if (pending === "settings_auto_tp") {
    await clearPending(ctx.from.id);
    const val = parseAmount(text);
    if (Number.isNaN(val) || val <= 0 || val > 500) {
      await ctx.reply("Invalid percentage. Enter between 1 and 500.");
      return;
    }
    const { saveSettings } = await import("../services/settings.js");
    await saveSettings(ctx.user.id, { autoTpPct: val });
    await ctx.reply(`✅ Auto TP set to +${val}%`);
    return;
  }

  if (pending === "settings_auto_sl") {
    await clearPending(ctx.from.id);
    const val = parseAmount(text);
    if (Number.isNaN(val) || val <= 0 || val > 100) {
      await ctx.reply("Invalid percentage. Enter between 1 and 100.");
      return;
    }
    const { saveSettings } = await import("../services/settings.js");
    await saveSettings(ctx.user.id, { autoSlPct: val });
    await ctx.reply(`✅ Auto SL set to -${val}%`);
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
    const symbol = parts[1];
    const triggerPrice = parseAmount(text);
    if (Number.isNaN(triggerPrice) || triggerPrice <= 0) {
      await ctx.reply("Invalid price. Enter a positive number.");
      return;
    }
    await clearPending(ctx.from.id);
    await sendPriceAlertConfirm(ctx, symbol, triggerPrice);
    return;
  }

  if (parts[0] === "addmargin") {
    if (!ctx.from) return;
    const symbol = parts[1];
    const amount = parseAmount(text);
    if (Number.isNaN(amount) || amount < 1) {
      const cancelKb = new InlineKeyboard().text("✕ Cancel", "cancel");
      await ctx.reply("Invalid amount. Enter $1 or more:", { reply_markup: cancelKb });
      return;
    }
    await clearPending(ctx.from.id);
    const kb = new InlineKeyboard()
      .text(`✅ Add ${usd(amount)}`, `addmargin:exec:${symbol}:${amount}`)
      .text("✕ Cancel", "cancel");
    const confirmMsg = fmt`Add ${FormattedString.b(usd(amount))} margin to ${FormattedString.b(symbol)}?`;
    await ctx.reply(confirmMsg.text, { entities: confirmMsg.entities, reply_markup: kb });
    return;
  }

  if (parts[0] === "tpsl_px") {
    const leg = parts[1] as "tp" | "sl";
    const symbol = parts[2];
    const positionSide = parts[3] as "long" | "short";
    const editIdx = parts[4] === "E" ? Number(parts[5]) : undefined;
    await handleTpSlPriceInput(ctx, leg, symbol, positionSide, text, editIdx);
    return;
  }

  if (parts[0] === "tpsl_sz") {
    const leg = parts[1] as "tp" | "sl";
    const symbol = parts[2];
    const positionSide = parts[3] as "long" | "short";
    const priceStr = parts[4];
    const editIdx = parts[5] === "E" ? Number(parts[6]) : undefined;
    await handleTpSlSizeInput(ctx, leg, symbol, positionSide, priceStr, text, editIdx);
    return;
  }

  if (parts[0] === "tpsl_editpx") {
    const leg = parts[1] as "tp" | "sl";
    const symbol = parts[2];
    const positionSide = parts[3] as "long" | "short";
    const idx = Number(parts[4]);
    await handleTpSlPriceInput(ctx, leg, symbol, positionSide, text, idx);
    return;
  }

  if (parts[0] === "tpsl_editsz") {
    const leg = parts[1] as "tp" | "sl";
    const symbol = parts[2];
    const positionSide = parts[3] as "long" | "short";
    const idx = Number(parts[4]);
    // Existing rung's price is needed; treat priceStr as "0" sentinel — the
    // handler looks the rung up by editIdx and uses its current triggerPrice.
    await handleTpSlSizeInput(ctx, leg, symbol, positionSide, "0", text, idx);
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

bot.on("callback_query:data", async (ctx) => {
  logger.warn({ data: ctx.callbackQuery.data, from: ctx.from?.id }, "unmatched callback query");
  await ctx.answerCallbackQuery();
});

bot.catch(async (err) => {
  const e = err.error;
  if (e instanceof GrammyError) {
    logger.error(
      { description: e.description, method: e.method, code: e.error_code },
      "GrammyError",
    );
  } else if (e instanceof HttpError) {
    logger.error({ err: e.error }, "HttpError — could not contact Telegram");
  } else {
    logger.error({ err: e, update: err.ctx.update }, "Bot error");
  }
  try {
    await renderBotError(err.ctx, e);
  } catch {
    // ctx may be invalid
  }
});

export function handleWebhook() {
  return webhookCallback(bot, "fastify");
}
