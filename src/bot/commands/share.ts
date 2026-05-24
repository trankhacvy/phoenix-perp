import { type Bot, InputFile } from "grammy";
import { generatePnlCard } from "../../services/image.js";
import { getTradeHistory } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";

export function registerShare(bot: Bot<BotContext>) {
  bot.command("share", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }
    if (!(await requireActivation(ctx))) return;

    const parts = ctx.match?.trim().split(" ");
    const symbol = parts?.[0]?.toUpperCase();
    if (!symbol) {
      await ctx.reply("Usage: /share <symbol>\nExample: /share SOL");
      return;
    }

    const history = await getTradeHistory(ctx.user.walletAddress, 20);
    // Find the most recent closing fill for this symbol (realizedPnl != 0)
    const trade = history.trades.find((t) => t.symbol === symbol && Number(t.realizedPnl) !== 0);

    if (!trade) {
      await ctx.reply(`No closed ${symbol} trades found.`);
      return;
    }

    const pnl = Number(trade.realizedPnl);
    const price = Number(trade.price);
    const size = Number(trade.size);
    const notional = price * size;
    const roiPercent = notional > 0 ? (pnl / notional) * 100 : 0;
    // Close fill side is inverted vs position side (short fill = closing a long)
    const positionSide = trade.side === "short" ? "long" : "short";
    const baseToken = symbol.replace("-PERP", "").replace(/USD.*/, "");

    const card = await generatePnlCard({
      symbol,
      side: positionSide,
      entryPrice: trade.price,
      exitPrice: trade.price,
      roiPercent,
      pnlUsdc: pnl,
      size: `${size.toFixed(4)} ${baseToken}`,
    });

    await ctx.replyWithPhoto(new InputFile(card, "pnl.png"));
  });
}
