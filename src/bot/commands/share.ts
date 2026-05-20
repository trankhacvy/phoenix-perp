import { InputFile, type Bot } from "grammy";
import { generatePnlCard } from "../../services/image.js";
import { getTradeHistory } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";

export function registerShare(bot: Bot<BotContext>) {
  bot.command("share", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const parts = ctx.match?.trim().split(" ");
    const symbol = parts?.[0]?.toUpperCase();
    if (!symbol) {
      await ctx.reply("Usage: /share <symbol>\nExample: /share SOL");
      return;
    }

    const history = await getTradeHistory(ctx.user.walletAddress, 20);
    const trade = history.trades.find((t) => t.symbol === symbol && t.status === "closed");

    if (!trade) {
      await ctx.reply(`No closed ${symbol} position found.`);
      return;
    }

    const botInfo = await bot.api.getMe();
    const card = await generatePnlCard({
      symbol,
      side: trade.side,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      roiPercent: trade.roiPercent,
      pnlUsdc: trade.realizedPnl,
      botHandle: `@${botInfo.username}`,
    });

    await ctx.replyWithPhoto(new InputFile(card, "pnl.png"), {
      caption: `${trade.side === "long" ? "🟢" : "🔴"} ${symbol} on @${botInfo.username} 🔥`,
    });
  });
}
