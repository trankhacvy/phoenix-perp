import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import { getMarketSnapshot } from "../../services/phoenix/market.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { placeMarketOrder } from "../../services/phoenix/trade.js";
import { getKitSigner } from "../../services/wallet.js";
import { subscribeUser } from "../../workers/ws.js";
import { setPending } from "../lib/pending.js";
import { usd, parseAmount, parseLeverage, solscanUrl } from "../lib/fmt.js";
import { sendSymbolPicker, sendLeveragePicker, sendSizePicker, sendTradeConfirm } from "./long.js";
import type { BotContext } from "../../types/index.js";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";

export function registerShort(bot: Bot<BotContext>) {
  bot.command("short", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
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
      if (isNaN(lev) || lev < 1 || isNaN(size) || size <= 0) {
        await ctx.reply(
          "Invalid format. Example: /short BTC 10x 500\nOr just type /short BTC to use the guided flow.",
        );
        return;
      }
      await sendTradeConfirm(ctx, "short", symbol, lev, size);
      return;
    }
    await sendLeveragePicker(ctx, "short", symbol);
  });

  bot.callbackQuery(/^trade:short:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    await sendLeveragePicker(ctx, "short", ctx.match[1]);
  });

  bot.callbackQuery(/^trade_lev:short:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendSizePicker(ctx, "short", ctx.match[1], Number(ctx.match[2]));
  });

  bot.callbackQuery(/^trade_lev_custom:short:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const symbol = ctx.match[1];
    const snap = await getMarketSnapshot(symbol).catch(() => null);
    const maxLev = snap?.maxLeverage ?? 100;
    await ctx.reply(`Enter your leverage for ${symbol} (1–${maxLev}x):`);
    await setPending(ctx.from.id, `trade_leverage:short:${symbol}`);
  });

  bot.callbackQuery(/^trade_size:short:([A-Z0-9]+):(\d+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendTradeConfirm(ctx, "short", ctx.match[1], Number(ctx.match[2]), Number(ctx.match[3]));
  });

  bot.callbackQuery(/^trade_size_custom:short:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, levStr] = ctx.match.slice(1);
    const state = await getTraderState(ctx.user.walletAddress);
    const available = Number(state.effectiveCollateral);
    const msg = fmt`Enter the margin amount in USD:\n(Available: ${FormattedString.code(usd(available))})`;
    await ctx.reply(msg.text, { entities: msg.entities });
    await setPending(ctx.from.id, `trade_size:short:${symbol}:${levStr}`);
  });

  bot.callbackQuery(/^confirm:short:([A-Z0-9]+):([\d.]+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Opening trade…");
    if (!ctx.user) return;
    const [symbol, leverageStr, sizeStr, markPriceStr] = ctx.match.slice(1);
    const lev = Number(leverageStr);
    const sizeUsdc = Number(sizeStr);
    const markPrice = Number(markPriceStr);

    try {
      const sig = await placeMarketOrder(
        {
          symbol,
          side: "short",
          baseUnits: String((sizeUsdc * lev) / markPrice),
          walletAddress: ctx.user.walletAddress,
        },
        getKitSigner(ctx.user.walletAddress),
      );
      await subscribeUser(ctx.user.walletAddress, ctx.user.telegramId);

      const kb = new InlineKeyboard()
        .text("📊 View positions", "nav:positions")
        .row()
        .text("🛑 Set stop loss", `editsl:${symbol}:short`)
        .text("🎯 Set take profit", `edittp:${symbol}:short`);

      const totalFee = (sizeUsdc * lev * (3.5 + config.BUILDER_FEE_BPS)) / 10000;
      const msg = fmt`✅ ${FormattedString.b("Trade opened!")}\n\n🔴 ${symbol}/USD — Short ${lev}x\nPosition: ${FormattedString.b(usd(sizeUsdc * lev))}\nFee paid: ${FormattedString.b(usd(totalFee))}\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}`;
      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      logger.error({ err: e, symbol, side: "short" }, "placeMarketOrder failed");
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      const kb = new InlineKeyboard()
        .text("Try again", `trade:short:${symbol}`)
        .text("← Back", "nav:positions");
      const errFmt = fmt`❌ ${FormattedString.b("Trade failed")}\n\n${symbol} Short\nReason: ${FormattedString.code(errMsg)}`;
      await ctx.editMessageText(errFmt.text, { entities: errFmt.entities, reply_markup: kb });
    }
  });
}
