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
import { saveBreakevenRuleFromInput, saveTrailRuleFromInput } from "./commands/guardian.js";
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

interface LinkPreviewPayload {
  link_preview_options?: { is_disabled: boolean };
}

// Default link previews off for every message we send, unless a caller set it.
bot.api.config.use((prev, method, payload, signal) => {
  if (
    (method === "sendMessage" || method === "editMessageText") &&
    payload &&
    !(payload as LinkPreviewPayload).link_preview_options
  ) {
    (payload as LinkPreviewPayload).link_preview_options = { is_disabled: true };
  }
  return prev(method, payload, signal);
});

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
    const val = parseAmount(text);
    if (Number.isNaN(val) || val <= 0 || val > 0.01) {
      await clearPending(ctx.from.id);
      const cancelKb = new InlineKeyboard().text("✕ Cancel", "settings:cancel_input");
      await ctx.reply("Invalid fee. Enter between 0.0001 and 0.01 SOL.", {
        reply_markup: cancelKb,
      });
      return;
    }
    await clearPending(ctx.from.id);
    const { saveSettings } = await import("../services/settings.js");
    await saveSettings(ctx.user.id, { feeMode: "custom", customFeeSol: val });
    const backKb = new InlineKeyboard().text("⚙️ Back to Settings", "settings:open");
    await ctx.reply(`✅ Custom fee set to ${val} SOL`, { reply_markup: backKb });
    return;
  }

  if (pending === "settings_auto_tp") {
    const val = parseAmount(text);
    if (Number.isNaN(val) || val <= 0 || val > 500) {
      await clearPending(ctx.from.id);
      const cancelKb = new InlineKeyboard().text("✕ Cancel", "settings:cancel_input");
      await ctx.reply("Invalid percentage. Enter between 1 and 500.", { reply_markup: cancelKb });
      return;
    }
    await clearPending(ctx.from.id);
    const { saveSettings } = await import("../services/settings.js");
    await saveSettings(ctx.user.id, { autoTpPct: val });
    const backKb = new InlineKeyboard().text("⚙️ Back to Settings", "settings:open");
    await ctx.reply(`✅ Auto TP set to +${val}%`, { reply_markup: backKb });
    return;
  }

  if (pending === "settings_auto_sl") {
    const val = parseAmount(text);
    if (Number.isNaN(val) || val <= 0 || val > 100) {
      await clearPending(ctx.from.id);
      const cancelKb = new InlineKeyboard().text("✕ Cancel", "settings:cancel_input");
      await ctx.reply("Invalid percentage. Enter between 1 and 100.", { reply_markup: cancelKb });
      return;
    }
    await clearPending(ctx.from.id);
    const { saveSettings } = await import("../services/settings.js");
    await saveSettings(ctx.user.id, { autoSlPct: val });
    const backKb = new InlineKeyboard().text("⚙️ Back to Settings", "settings:open");
    await ctx.reply(`✅ Auto SL set to -${val}%`, { reply_markup: backKb });
    return;
  }

  if (pending === "settings_custom_slip") {
    const val = parseAmount(text);
    if (Number.isNaN(val) || val < 0.01 || val > 5) {
      await clearPending(ctx.from.id);
      const cancelKb = new InlineKeyboard().text("✕ Cancel", "settings:cancel_input");
      await ctx.reply("Invalid slippage. Enter between 0.01 and 5.00 (%).", {
        reply_markup: cancelKb,
      });
      return;
    }
    await clearPending(ctx.from.id);
    const { saveSettings } = await import("../services/settings.js");
    await saveSettings(ctx.user.id, { slippageBps: Math.round(val * 100) });
    const backKb = new InlineKeyboard().text("⚙️ Back to Settings", "settings:open");
    await ctx.reply(`✅ Slippage set to ${val}%`, { reply_markup: backKb });
    return;
  }

  if (pending === "settings_custom_lev") {
    const raw = parseAmount(text);
    const val = Math.round(raw);
    if (Number.isNaN(raw) || val < 1 || val > 100) {
      await clearPending(ctx.from.id);
      const cancelKb = new InlineKeyboard().text("✕ Cancel", "settings:cancel_input");
      await ctx.reply("Invalid leverage. Enter a whole number between 1 and 100.", {
        reply_markup: cancelKb,
      });
      return;
    }
    await clearPending(ctx.from.id);
    const { saveSettings } = await import("../services/settings.js");
    await saveSettings(ctx.user.id, { defaultLeverage: val });
    const backKb = new InlineKeyboard().text("⚙️ Back to Settings", "settings:open");
    await ctx.reply(`✅ Default leverage set to ${val}×`, { reply_markup: backKb });
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

  if (parts[0] === "pricealert" || parts[0] === "al_pricealert") {
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

  if (parts[0] === "grd_threshold") {
    const ruleType = parts[1];
    const symbol = parts[2];
    const val = parseAmount(text);
    if (Number.isNaN(val) || val <= 0) {
      await ctx.reply("Invalid value. Enter a positive number.");
      return;
    }
    await clearPending(ctx.from.id);
    const kb = new InlineKeyboard()
      .text("🔔 Notify only", `grd:act:${ruleType}:${symbol}:${val}:notify`)
      .row()
      .text("🔔 Suggest actions", `grd:act:${ruleType}:${symbol}:${val}:suggest`)
      .row()
      .text("⚡ Auto-close", `grd:act:${ruleType}:${symbol}:${val}:auto_close`)
      .row()
      .text("✕ Cancel", "grd:list");
    await ctx.reply(`Value set to ${val}. Choose an action:`, { reply_markup: kb });
    return;
  }

  if (parts[0] === "grd_margin_amt") {
    const [, ruleType, symbol, threshold] = parts;
    const val = parseAmount(text);
    if (Number.isNaN(val) || val < 1) {
      await ctx.reply("Invalid amount. Enter $1 or more.");
      return;
    }
    await clearPending(ctx.from.id);
    const encoded = `${ruleType}:${symbol}:${threshold}:auto_margin:${val}`;
    const kb = new InlineKeyboard()
      .text("✅ Save rule", `grd:save:${encoded}`)
      .text("✕ Cancel", "grd:list");
    await ctx.reply(`Auto-add $${val} margin. Save this rule?`, { reply_markup: kb });
    return;
  }

  if (parts[0] === "protect_trail") {
    const [, symbol, side] = parts;
    const valTrail = parseAmount(text);
    if (Number.isNaN(valTrail) || valTrail <= 0 || valTrail >= 100) {
      await ctx.reply("Enter a trail distance between 0 and 100% (e.g. 4):");
      return; // keep pending so the user can retry
    }
    try {
      const done = await saveTrailRuleFromInput(ctx, symbol, side as "long" | "short", valTrail);
      if (done) await clearPending(ctx.from.id);
    } catch (err) {
      await clearPending(ctx.from.id);
      await renderBotError(ctx, err, { action: "set trailing stop" });
    }
    return;
  }

  if (parts[0] === "protect_be") {
    const [, symbol, side] = parts;
    const valBe = parseAmount(text);
    if (Number.isNaN(valBe) || valBe <= 0) {
      await ctx.reply("Enter a positive profit % (e.g. 25):");
      return; // keep pending so the user can retry
    }
    try {
      const done = await saveBreakevenRuleFromInput(ctx, symbol, side as "long" | "short", valBe);
      if (done) await clearPending(ctx.from.id);
    } catch (err) {
      await clearPending(ctx.from.id);
      await renderBotError(ctx, err, { action: "set breakeven" });
    }
    return;
  }

  if (parts[0] === "mon_label") {
    const monitorId = parts[1];
    const label = text.slice(0, 32).trim();
    if (!label) {
      await ctx.reply("Label can't be empty.");
      return;
    }
    await clearPending(ctx.from.id);
    const { walletMonitors } = await import("../db/schema/index.js");
    const { eq, and } = await import("drizzle-orm");
    const { db } = await import("../db/index.js");
    await db
      .update(walletMonitors)
      .set({ label })
      .where(and(eq(walletMonitors.id, monitorId), eq(walletMonitors.userId, ctx.user.id)));
    await ctx.reply(`✅ Label updated to "${label}"`);
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
