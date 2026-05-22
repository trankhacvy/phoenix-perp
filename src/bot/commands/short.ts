import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import { trackAction } from "../../services/action-log.js";
import { marginToTokens } from "../../services/phoenix/lots.js";
import { getMarketSnapshot } from "../../services/phoenix/market.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { type PreflightResult, preflightOpen } from "../../services/phoenix/preflight.js";
import { placeMarketOrder } from "../../services/phoenix/trade.js";
import { getKitSigner } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { subscribeUser } from "../../workers/ws.js";
import { renderBotError, toBotError } from "../lib/errors.js";
import { parseAmount, parseLeverage, solscanUrl, usd } from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";
import { sendLeveragePicker, sendSizePicker, sendSymbolPicker, sendTradeConfirm } from "./long.js";

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
      if (Number.isNaN(lev) || lev < 1 || Number.isNaN(size) || size <= 0) {
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

  bot.callbackQuery(/^trade_lev:short:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
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

  bot.callbackQuery(/^trade_size:short:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendTradeConfirm(ctx, "short", ctx.match[1], Number(ctx.match[2]), Number(ctx.match[3]));
  });

  bot.callbackQuery(/^trade_size_custom:short:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
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
    const [symbol, leverageStr, sizeStr, anchorStr] = ctx.match.slice(1);
    const lev = Number(leverageStr);
    const sizeUsdc = Number(sizeStr);
    const anchorPrice = Number(anchorStr);

    let pf: PreflightResult;
    try {
      pf = await preflightOpen({
        user: ctx.user,
        symbol,
        side: "short",
        marginUsdc: sizeUsdc,
        leverage: lev,
        anchorPrice,
      });
    } catch (e) {
      const be = toBotError(e);
      ctx.actionLog = { outcome: "error", errorCode: be.code, errorCategory: be.category };
      const kb = new InlineKeyboard()
        .text("Try again", `trade:short:${symbol}`)
        .text("← Back", "nav:positions");
      await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
      return;
    }

    try {
      const baseUnits = marginToTokens(
        pf.snapshot,
        sizeUsdc,
        pf.effectiveLeverage,
        anchorPrice > 0 ? anchorPrice : undefined,
      );
      const userId = ctx.user.id;
      const walletAddress = ctx.user.walletAddress;
      const sig = await trackAction(
        {
          userId,
          command: "trade.short",
          args: {
            symbol,
            leverage: pf.effectiveLeverage,
            marginUsdc: sizeUsdc,
            notional: pf.notional,
          },
        },
        () =>
          placeMarketOrder(
            {
              symbol,
              side: "short",
              baseUnits,
              walletAddress,
            },
            getKitSigner(walletAddress),
          ),
      );
      ctx.actionLog = { skip: true };
      await subscribeUser(ctx.user.walletAddress, ctx.user.telegramId);

      const kb = new InlineKeyboard()
        .text("📊 View positions", "nav:positions")
        .row()
        .text("🛑 Set stop loss", `editsl:${symbol}:short`)
        .text("🎯 Set take profit", `edittp:${symbol}:short`);

      const msg = fmt`✅ ${FormattedString.b("Trade opened!")}\n\n🔴 ${symbol}/USD — Short ${pf.effectiveLeverage}x\nPosition: ${FormattedString.b(usd(pf.notional))}\nFee paid: ${FormattedString.b(usd(pf.feeUsdc))}\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}`;
      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      logger.error({ err: e, symbol, side: "short" }, "placeMarketOrder failed");
      ctx.actionLog = { skip: true };
      const kb = new InlineKeyboard()
        .text("Try again", `trade:short:${symbol}`)
        .text("← Back", "nav:positions");
      await renderBotError(ctx, e, { action: "Trade", edit: true, replyMarkup: kb });
    }
  });
}
