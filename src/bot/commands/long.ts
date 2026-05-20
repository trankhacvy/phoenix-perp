import type { Bot } from "grammy";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/index.js";
import { getMarketSnapshot, isIsolatedOnly } from "../../services/phoenix/market.js";
import { placeMarketOrder } from "../../services/phoenix/trade.js";
import { subscribeUser } from "../../workers/ws.js";
import { confirmKeyboard } from "../keyboards/trade.js";
import type { BotContext } from "../../types/index.js";
import { config } from "../../config/index.js";

export function registerLong(bot: Bot<BotContext>) {
  bot.command("long", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const parts = ctx.match?.trim().split(" ");
    if (!parts || parts.length < 3) {
      await ctx.reply("Usage: /long <symbol> <leverage>x <size_usdc>\nExample: /long SOL 5x 100");
      return;
    }

    const symbol = parts[0].toUpperCase();
    const leverage = Number(parts[1].replace("x", ""));
    const sizeUsdc = Number(parts[2]);

    if (Number.isNaN(leverage) || Number.isNaN(sizeUsdc) || leverage <= 0 || sizeUsdc <= 0) {
      await ctx.reply("Invalid leverage or size.");
      return;
    }

    if (isIsolatedOnly(symbol)) {
      await ctx.reply(
        `⚠️ <b>${symbol}</b> is an isolated-margin-only market.\nIsolated positions require a dedicated subaccount. Coming soon.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const settings = (await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, ctx.user.id),
    })) ?? { slippageBps: 50, defaultLeverage: 5 };

    let snapshot;
    try {
      snapshot = await getMarketSnapshot(symbol);
    } catch {
      await ctx.reply(`❌ Could not fetch market data for ${symbol}. Check the symbol and try again.`);
      return;
    }

    const effectiveLeverage = Math.min(leverage, snapshot.maxLeverage);
    const notional = sizeUsdc * effectiveLeverage;
    const estimatedEntry = snapshot.markPrice;
    const estimatedLiq = estimatedEntry * (1 - 1 / effectiveLeverage);
    const phoenixFee = (notional * 3.5) / 10000;
    const builderFee = (notional * config.BUILDER_FEE_BPS) / 10000;

    const warning =
      leverage > snapshot.maxLeverage
        ? `\n⚠️ Leverage capped to max <b>${snapshot.maxLeverage}x</b> for ${symbol}.\n`
        : "";

    const kb = confirmKeyboard(`long:${symbol}:${effectiveLeverage}:${sizeUsdc}`);

    await ctx.reply(
      [
        `🟢 <b>Long ${symbol}</b>`,
        warning,
        `Leverage: <code>${effectiveLeverage}x</code>`,
        `Size: <code>$${sizeUsdc} USDC</code>  |  Notional: <code>$${notional.toFixed(2)}</code>`,
        `Entry (est.): <code>$${estimatedEntry.toFixed(4)}</code>`,
        `Liq price (est.): <code>$${estimatedLiq.toFixed(4)}</code>`,
        `Slippage: <code>${settings.slippageBps / 100}%</code>`,
        ``,
        `Phoenix fee: <code>$${phoenixFee.toFixed(4)}</code> (3.5 bps)`,
        `Builder fee: <code>$${builderFee.toFixed(4)}</code> (${config.BUILDER_FEE_BPS} bps)`,
        ``,
        `⚠️ SL executes as IOC with 10% slippage buffer if set to Market mode.`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^confirm:long:(.+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Placing order...");
    if (!ctx.user) return;

    const [symbol, leverageStr, sizeStr] = ctx.match.slice(1);
    const leverage = Number(leverageStr);
    const sizeUsdc = Number(sizeStr);

    const settings = (await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, ctx.user.id),
    })) ?? { slippageBps: 50 };

    try {
      const sig = await placeMarketOrder({
        symbol,
        side: "long",
        sizeUsdc: sizeUsdc * leverage,
        slippageBps: settings.slippageBps,
        walletAddress: ctx.user.walletAddress,
      });
      await subscribeUser(ctx.user.walletAddress, ctx.user.telegramId);
      await ctx.editMessageText(
        `✅ <b>Long ${symbol} opened!</b>\n\nTx: <code>${sig}</code>`,
        { parse_mode: "HTML" },
      );
    } catch {
      await ctx.editMessageText("❌ Order failed. Please try again.");
    }
  });
}
