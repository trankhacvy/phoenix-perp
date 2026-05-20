import type { Bot } from "grammy";
import { getTradeHistory } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";

export function registerHistory(bot: Bot<BotContext>) {
  bot.command("history", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const pageArg = Number(ctx.match?.trim() || "1");
    const page = Number.isNaN(pageArg) || pageArg < 1 ? 1 : pageArg;
    const limit = 10;
    const offset = (page - 1) * limit;

    const history = await getTradeHistory(ctx.user.walletAddress, limit, offset);
    const trades = history.trades;

    if (trades.length === 0) {
      await ctx.reply("No trade history yet.");
      return;
    }

    const lines = trades.map((t, i) => {
      const pnl = Number(t.realizedPnl ?? 0);
      const sign = pnl >= 0 ? "+" : "";
      return `${offset + i + 1}. <b>${t.symbol} ${t.side.toUpperCase()}</b> — ${sign}${pnl.toFixed(2)} USDC`;
    });

    await ctx.reply(
      [`📜 <b>Trade History (page ${page})</b>`, ``, ...lines].join("\n"),
      { parse_mode: "HTML" },
    );
  });
}
