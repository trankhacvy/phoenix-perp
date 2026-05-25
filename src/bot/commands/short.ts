import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { trackAction } from "../../services/action-log.js";
import { marginToTokens } from "../../services/phoenix/lots.js";
import { getMarketSnapshot } from "../../services/phoenix/market.js";
import { type PreflightResult, preflightOpen } from "../../services/phoenix/preflight.js";
import { placeMarketOrder } from "../../services/phoenix/trade.js";
import { recordTrade } from "../../services/trade-log.js";
import type { BotContext } from "../../types/index.js";
import { subscribeUser } from "../../workers/ws.js";
import { renderBotError, toBotError } from "../lib/errors.js";
import { price as fmtPrice, num, parseAmount, parseLeverage, solscanUrl, usd } from "../lib/fmt.js";
import { claimIdempotencyKey } from "../lib/idempotent.js";
import { setPending } from "../lib/pending.js";
import { checkOrderRateLimit } from "../middleware/rate-limit.js";

const TRADE_LOCK_TTL = 150;
import {
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
      if (be.code === "PRICE_DRIFT") {
        const kb = new InlineKeyboard()
          .text("🔄 Refresh price", `trade_refresh:short:${symbol}:${lev}:${sizeUsdc}`)
          .row()
          .text("✕ Cancel", "cancel");
        await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
        return;
      }
      const kb = new InlineKeyboard()
        .text("← Resize", `trade:short:${symbol}`)
        .text("✕ Cancel", "cancel");
      await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
      return;
    }

    const tradeLockKey = `trade:lock:${ctx.user.id}`;
    const tradeLocked = await redis.set(tradeLockKey, "1", "EX", TRADE_LOCK_TTL, "NX");
    if (!tradeLocked) {
      await ctx.editMessageText("Another trade is in progress. Wait a moment and try again.");
      return;
    }

    ctx.actionLog = { skip: true };
    await ctx.editMessageText("⏳ Submitting order to Solana…");

    const user = ctx.user;
    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    const api = ctx.api;

    if (!chatId || !msgId) {
      await redis.del(tradeLockKey);
      return;
    }

    void (async () => {
      try {
        const baseUnits = marginToTokens(pf.snapshot, sizeUsdc, pf.effectiveLeverage);
        const { walletAddress: wallet, telegramId } = user;
        const sig = await trackAction(
          {
            userId: user.id,
            command: "trade.short",
            args: {
              symbol,
              leverage: pf.effectiveLeverage,
              marginUsdc: sizeUsdc,
              notional: pf.notional,
            },
          },
          () =>
            placeMarketOrder({
              symbol,
              side: "short",
              baseUnits,
              walletAddress: wallet,
            }),
        );

        recordTrade({
          userId: user.id,
          walletAddress: wallet,
          symbol,
          side: "short",
          action: "open",
          marginUsdc: sizeUsdc,
          leverage: pf.effectiveLeverage,
          notionalUsdc: pf.notional,
          baseUnits,
          markPrice: pf.snapshot.markPrice,
          feeUsdc: pf.feeUsdc,
          txSignature: sig,
        });

        await subscribeUser(wallet, telegramId);

        const tokenSize = pf.notional / pf.snapshot.markPrice;
        const kb = new InlineKeyboard()
          .text("🛑 Set SL", `editsl:${symbol}:short`)
          .text("🎯 Set TP", `edittp:${symbol}:short`)
          .row()
          .text("📊 View position", "nav:positions");

        const msg = fmt`✅ ${FormattedString.b(`Short ${usd(pf.notional, 0, 0)} of ${symbol} opened`)}\n\nEntry:     ~${FormattedString.b(fmtPrice(pf.snapshot.markPrice))}\nSize:      ~${FormattedString.b(`${num(tokenSize, 2, 4)} ${symbol}`)}\nFee paid:  ${FormattedString.b(usd(pf.feeUsdc))}\nLiq price: ~${FormattedString.b(fmtPrice(pf.liqPrice))}\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}`;
        await api.editMessageText(chatId, msgId, msg.text, {
          entities: msg.entities,
          reply_markup: kb,
          link_preview_options: { is_disabled: true },
        });
      } catch (e) {
        logger.error({ err: e, symbol, side: "short" }, "placeMarketOrder failed");
        const be = toBotError(e);
        const retryLine = be.retryable ? fmt`\n\n↩️ ${FormattedString.i("Safe to retry.")}` : fmt``;
        const hintLine = be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``;
        const errMsg = fmt`${FormattedString.b("❌ Trade failed")}\n\n${be.userMessage}${hintLine}${retryLine}`;
        const kb = new InlineKeyboard()
          .text("Try again", `trade:short:${symbol}`)
          .text("← Back", "nav:positions");
        try {
          await api.editMessageText(chatId, msgId, errMsg.text, {
            entities: errMsg.entities,
            reply_markup: kb,
          });
        } catch (editErr) {
          logger.error({ err: editErr }, "failed to edit error message for short trade");
        }
      }
    })()
      .finally(() => redis.del(tradeLockKey))
      .catch((err) => logger.error({ err }, "short trade async error"));
  });
}
