import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { setTpSl } from "../../services/phoenix/trade.js";
import type { BotContext } from "../../types/index.js";

export function registerSetTp(bot: Bot<BotContext>) {
  bot.command("settp", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const parts = ctx.match?.trim().split(" ");
    if (!parts || parts.length < 2) {
      await ctx.reply(
        "Usage: /settp <symbol> <price> [market|limit]\nExample: /settp SOL 250.00",
      );
      return;
    }

    const symbol = parts[0].toUpperCase();
    const price = Number(parts[1]);
    const mode = parts[2] === "limit" ? "limit" : "market";

    if (Number.isNaN(price) || price <= 0) {
      await ctx.reply("Invalid price.");
      return;
    }

    const kb = new InlineKeyboard()
      .text("✅ Confirm", `settp:confirm:${symbol}:${price}:${mode}`)
      .text("❌ Cancel", "cancel");

    await ctx.reply(
      [
        `🎯 <b>Set Take-Profit: ${symbol}</b>`,
        ``,
        `Trigger price: <code>$${price}</code>`,
        `Execution: <b>${mode === "market" ? "Market (IOC, ±10% buffer)" : "Limit"}</b>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^settp:confirm:(.+):([\d.]+):(market|limit)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Setting TP...");
    if (!ctx.user) return;
    const [symbol, priceStr, mode] = ctx.match.slice(1) as [string, string, "market" | "limit"];
    try {
      await setTpSl({
        symbol,
        walletAddress: ctx.user.walletAddress,
        tpPrice: Number(priceStr),
        tpMode: mode,
      });
      await ctx.editMessageText(`✅ Take-profit for ${symbol} set at $${priceStr}.`);
    } catch {
      await ctx.editMessageText("❌ Failed to set take-profit.");
    }
  });
}
