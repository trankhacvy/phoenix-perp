import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { setTpSl } from "../../services/phoenix/trade.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { getKitSigner } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";

export function registerSetSl(bot: Bot<BotContext>) {
  bot.command("setsl", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const parts = ctx.match?.trim().split(" ");
    if (!parts || parts.length < 2) {
      await ctx.reply(
        "Usage: /setsl <symbol> <price> [market|limit]\nExample: /setsl SOL 150.00",
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

    let positionSide: "long" | "short";
    try {
      const state = await getTraderState(ctx.user.walletAddress);
      const pos = state.positions.find((p) => p.symbol === symbol);
      if (!pos) {
        await ctx.reply(`No open ${symbol} position found. Open a position first.`);
        return;
      }
      positionSide = pos.side;
    } catch {
      await ctx.reply("❌ Failed to fetch position. Please try again.");
      return;
    }

    const kb = new InlineKeyboard()
      .text("✅ Confirm", `setsl:confirm:${symbol}:${price}:${mode}:${positionSide}`)
      .text("❌ Cancel", "cancel");

    await ctx.reply(
      [
        `🛑 <b>Set Stop-Loss: ${symbol}</b>`,
        ``,
        `Side: <b>${positionSide.toUpperCase()}</b>`,
        `Trigger price: <code>$${price}</code>`,
        `Execution: <b>${mode === "market" ? "Market (IOC, ±10% buffer)" : "Limit"}</b>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^setsl:confirm:([A-Z0-9]+):([\d.]+):(market|limit):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Setting SL...");
    if (!ctx.user) return;
    const [symbol, priceStr, mode, positionSide] = ctx.match.slice(1) as [string, string, "market" | "limit", "long" | "short"];
    try {
      await setTpSl(
        { symbol, walletAddress: ctx.user.walletAddress, positionSide, slPrice: Number(priceStr), slMode: mode },
        getKitSigner(ctx.user.walletAddress),
      );
      await ctx.editMessageText(`✅ Stop-loss for ${symbol} set at $${priceStr}.`);
    } catch {
      await ctx.editMessageText("❌ Failed to set stop-loss.");
    }
  });
}
