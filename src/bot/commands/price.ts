import type { Bot } from "grammy";
import { getMarket } from "../../services/phoenix/market.js";
import { marketActionKeyboard } from "../keyboards/market.js";
import type { BotContext } from "../../types/index.js";

export function registerPrice(bot: Bot<BotContext>) {
  bot.command("price", async (ctx) => {
    const symbol = ctx.match?.trim().toUpperCase();
    if (!symbol) {
      await ctx.reply("Usage: /price SOL");
      return;
    }

    const market = await getMarket(symbol);

    await ctx.reply(
      [
        `📈 <b>${symbol}</b>`,
        ``,
        `Mark price: <code>$${market.markPrice ?? "—"}</code>`,
        `Oracle price: <code>$${market.oraclePrice ?? "—"}</code>`,
        `Funding APR: <code>${market.fundingRate ?? "—"}%</code>`,
        `Open interest: <code>$${market.openInterest ?? "—"}</code>`,
        `24h volume: <code>$${market.volume24h ?? "—"}</code>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: marketActionKeyboard(symbol) },
    );
  });
}
