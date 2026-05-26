import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { getMarketSnapshot } from "../../services/phoenix/market.js";
import { getSettings } from "../../services/settings.js";
import type { BotContext } from "../../types/index.js";
import { parseAmount, parseLeverage, usd } from "../lib/fmt.js";
import { claimIdempotencyKey } from "../lib/idempotent.js";
import { setPending } from "../lib/pending.js";
import { checkOrderRateLimit } from "../middleware/rate-limit.js";
import {
  executeTrade,
  sendLevStep,
  sendSizeStep,
  sendSymbolPicker,
  sendSymbolPickerPage,
  sendTradeConfirm,
} from "./long.js";

export function registerShort(bot: Bot<BotContext>) {
  bot.command("short", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }
    if (!ctx.user.phoenixActivated) {
      const kb = new InlineKeyboard().text("Activate account", "nav:activate");
      await ctx.reply(
        "Your trading account isn't activated yet.\nUse /activate <code> to unlock trading.",
        { reply_markup: kb },
      );
      return;
    }

    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const symbol = parts[0]?.toUpperCase().replace("/USD", "").replace("/USDT", "");

    if (!symbol) {
      await sendSymbolPicker(ctx, "short");
      return;
    }

    if (parts.length >= 3) {
      const lev = parseLeverage(parts[1]);
      const size = parseAmount(parts[2]);
      if (Number.isNaN(lev) || lev < 1 || !Number.isFinite(lev)) {
        await ctx.reply(
          "Invalid leverage — use a number like 10 or 2.5x (minimum 1).\nExample: /short BTC 10x 500",
        );
        return;
      }
      const snap = await getMarketSnapshot(symbol).catch(() => null);
      const maxLev = snap?.maxLeverage ?? 100;
      if (lev > maxLev) {
        await ctx.reply(
          `Max leverage for ${symbol} is ${maxLev}×. Try: /short ${symbol} ${maxLev}x ${parts[2]}`,
        );
        return;
      }
      if (Number.isNaN(size) || size <= 0) {
        await ctx.reply("Invalid amount.\nExample: /short BTC 10x 500");
        return;
      }
      await sendTradeConfirm(ctx, "short", symbol, lev, size);
      return;
    }

    await sendSizeStep(ctx, "short", symbol);
  });

  bot.callbackQuery(/^trade_sym:short:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendSymbolPickerPage(ctx, "short", Number(ctx.match[1]), true);
  });

  bot.callbackQuery(/^trade:short:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!ctx.user.phoenixActivated) {
      await ctx.reply("Activate your account first. Use /activate <code>.");
      return;
    }
    await sendSizeStep(ctx, "short", ctx.match[1]);
  });

  bot.callbackQuery(/^trade_size:short:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendLevStep(ctx, "short", ctx.match[1], Number(ctx.match[2]));
  });

  bot.callbackQuery(/^trade_size_custom:short:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const symbol = ctx.match[1];
    const { getTraderState } = await import("../../services/phoenix/position.js");
    const state = await getTraderState(ctx.user.walletAddress);
    const available = Number(state.effectiveCollateral);
    const msg = fmt`Enter the amount you want to risk (USD):\n(Your balance: ${FormattedString.code(usd(available))})`;
    await ctx.reply(msg.text, { entities: msg.entities });
    await setPending(ctx.from.id, `trade_size_input:short:${symbol}`);
  });

  bot.callbackQuery(/^trade_lev:short:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, amtStr, levStr] = ctx.match.slice(1);
    const settings = await getSettings(ctx.user.id);
    if (!settings.confirmTrades) {
      await executeTrade(ctx, "short", symbol, Number(levStr), Number(amtStr));
      return;
    }
    await sendTradeConfirm(ctx, "short", symbol, Number(levStr), Number(amtStr));
  });

  bot.callbackQuery(/^trade_lev_custom:short:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, amtStr] = ctx.match.slice(1);
    const { getMarketSnapshot } = await import("../../services/phoenix/market.js");
    const snap = await getMarketSnapshot(symbol).catch(() => null);
    const maxLev = snap?.maxLeverage ?? 100;
    await ctx.reply(`Enter your leverage for ${symbol} (1–${maxLev}×):`);
    await setPending(ctx.from.id, `trade_lev_input:short:${symbol}:${amtStr}`);
  });

  bot.callbackQuery(/^trade_refresh:short:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Refreshing…");
    if (!ctx.user) return;
    const [symbol, levStr, amtStr] = ctx.match.slice(1);
    await sendTradeConfirm(ctx, "short", symbol, Number(levStr), Number(amtStr), true);
  });

  bot.callbackQuery(/^confirm:short:([A-Z0-9]+):([\d.]+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Opening…");
    if (!ctx.user) return;
    if (!(await checkOrderRateLimit(ctx))) return;

    if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id))) return;

    const [symbol, leverageStr, sizeStr, anchorStr] = ctx.match.slice(1);
    await executeTrade(
      ctx,
      "short",
      symbol,
      Number(leverageStr),
      Number(sizeStr),
      Number(anchorStr),
    );
  });
}
