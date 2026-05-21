import type { Bot } from "grammy";
import { getMarketSnapshot, getMarketStatsHistory } from "../../services/phoenix/market.js";
import { marketActionKeyboard } from "../keyboards/market.js";
import type { BotContext } from "../../types/index.js";

export function registerPrice(bot: Bot<BotContext>) {
  bot.command("price", async (ctx) => {
    const symbol = ctx.match?.trim().toUpperCase();
    if (!symbol) {
      await ctx.reply("Usage: /price SOL");
      return;
    }

    const [snapshot, stats] = await Promise.all([
      getMarketSnapshot(symbol),
      getMarketStatsHistory(symbol, 1),
    ]);

    const oi = stats?.stats?.[0]?.open_interest;
    const oiStr = oi != null ? String(oi) : "—";

    await ctx.reply(
      [
        `📈 <b>${symbol}</b>`,
        ``,
        `Mark price: <code>$${snapshot.markPrice.toFixed(4)}</code>`,
        `Funding APR: <code>${(snapshot.fundingRate * 100).toFixed(4)}%</code>`,
        `Open interest: <code>${oiStr}</code>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: marketActionKeyboard(symbol) },
    );
  });
}
