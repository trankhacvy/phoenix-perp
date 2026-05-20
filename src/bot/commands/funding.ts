import type { Bot } from "grammy";
import { getMarkets } from "../../services/phoenix/market.js";
import type { BotContext } from "../../types/index.js";

export function registerFunding(bot: Bot<BotContext>) {
  bot.command("funding", async (ctx) => {
    const data = await getMarkets();
    const markets: Record<string, unknown>[] = Array.isArray(data) ? data : (data.markets ?? []);

    const sorted = markets
      .filter((m) => m.fundingRate != null)
      .sort((a, b) => Math.abs(Number(b.fundingRate)) - Math.abs(Number(a.fundingRate)))
      .slice(0, 10);

    const lines = sorted.map((m, i) => {
      const rate = Number(m.fundingRate);
      const sign = rate > 0 ? "📈 Longs pay" : "📉 Shorts pay";
      return `${i + 1}. <b>${m.symbol}</b> ${rate.toFixed(4)}% apr — ${sign}`;
    });

    await ctx.reply(
      [`💸 <b>Top Funding Rates</b>`, ``, ...lines].join("\n"),
      { parse_mode: "HTML" },
    );
  });
}
