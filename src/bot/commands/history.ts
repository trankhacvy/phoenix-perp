import type { Bot } from "grammy";
import { getTradeHistory } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";

export function registerHistory(bot: Bot<BotContext>) {
  bot.command("history", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const history = await getTradeHistory(ctx.user.walletAddress, 20);
    const trades = history.trades;

    if (trades.length === 0) {
      await ctx.reply("No trade history yet.");
      return;
    }

    const lines = trades.map((t, i) => {
      const pnl = Number(t.realizedPnl ?? 0);
      const pnlStr = pnl >= 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4);
      const date = new Date(t.timestamp).toISOString().slice(0, 10);
      return `${i + 1}. <b>${t.symbol} ${t.side.toUpperCase()}</b>  @$${Number(t.price).toFixed(2)}  |  pnl: <code>${pnlStr}</code>  <i>${date}</i>`;
    });

    const footer = history.hasMore ? `\n<i>Showing 20 most recent. More trades exist.</i>` : "";

    await ctx.reply(
      [`📜 <b>Recent Trades</b>`, ``, ...lines, footer].join("\n"),
      { parse_mode: "HTML" },
    );
  });
}
