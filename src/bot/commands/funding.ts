import type { Bot } from "grammy";
import { getPhoenixClient } from "../../services/phoenix/client.js";
import type { BotContext } from "../../types/index.js";

export function registerFunding(bot: Bot<BotContext>) {
  bot.command("funding", async (ctx) => {
    const overview = await getPhoenixClient().api.funding().getFundingOverview().catch(() => null);
    const series = overview?.series ?? [];

    const rows = series
      .map((s) => {
        const latest = s.points.at(-1);
        return latest ? { symbol: s.symbol, rate: Number(latest.fundingRate) } : null;
      })
      .filter((r): r is { symbol: string; rate: number } => r !== null && r.rate !== 0)
      .sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))
      .slice(0, 10);

    const lines = rows.map((r, i) => {
      const sign = r.rate > 0 ? "📈 Longs pay" : "📉 Shorts pay";
      return `${i + 1}. <b>${r.symbol}</b> ${(r.rate * 100).toFixed(4)}% apr — ${sign}`;
    });

    const body = lines.length > 0
      ? [`💸 <b>Top Funding Rates</b>`, ``, ...lines].join("\n")
      : `💸 <b>Top Funding Rates</b>\n\nNo significant funding rates right now.`;

    await ctx.reply(body, { parse_mode: "HTML" });
  });
}
