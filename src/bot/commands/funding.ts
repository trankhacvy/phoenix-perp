import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { getPhoenixClient } from "../../services/phoenix/client.js";
import type { BotContext } from "../../types/index.js";

export function registerFunding(bot: Bot<BotContext>) {
  bot.command("funding", async (ctx) => {
    const overview = await getPhoenixClient()
      .api.funding()
      .getFundingOverview()
      .catch(() => null);
    const series = overview?.series ?? [];

    const rows = series
      .map((s) => {
        const latest = s.points.at(-1);
        return latest ? { symbol: s.symbol, rate: Number(latest.fundingRate) } : null;
      })
      .filter((r): r is { symbol: string; rate: number } => r !== null && r.rate !== 0)
      .sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))
      .slice(0, 10);

    if (rows.length === 0) {
      const msg = fmt`💸 ${FormattedString.b("Top Funding Rates")}\n\nAll funding rates are near zero right now.`;
      await ctx.reply(msg.text, { entities: msg.entities });
      return;
    }

    const lines = rows.map((r, i) => {
      const sign = r.rate > 0 ? "📈 Longs pay" : "📉 Shorts pay";
      return fmt`${i + 1}. ${FormattedString.b(r.symbol)} ${(r.rate * 100).toFixed(4)}% apr — ${sign}`;
    });

    const msg = FormattedString.join(
      [fmt`💸 ${FormattedString.b("Top Funding Rates")}`, fmt``, ...lines],
      "\n",
    );
    await ctx.reply(msg.text, { entities: msg.entities });
  });
}
