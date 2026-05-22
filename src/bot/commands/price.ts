import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import {
  getMarketSnapshot,
  getMarketStatsHistory,
  isIsolatedOnly,
} from "../../services/phoenix/market.js";
import { price as fmtPrice, usd, fundingApr, fundingDir } from "../lib/fmt.js";
import type { BotContext } from "../../types/index.js";

export function registerPrice(bot: Bot<BotContext>) {
  bot.command("price", async (ctx) => {
    const symbol = ctx.match?.trim().toUpperCase();
    if (!symbol) {
      await ctx.reply("Usage: /price SOL");
      return;
    }
    await sendPriceScreen(ctx, symbol);
  });

  bot.callbackQuery(/^price:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPriceScreen(ctx, ctx.match[1]);
  });
}

export async function sendPriceScreen(ctx: BotContext, symbol: string): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof getMarketSnapshot>>;
  let stats: Awaited<ReturnType<typeof getMarketStatsHistory>>;
  try {
    [snapshot, stats] = await Promise.all([
      getMarketSnapshot(symbol),
      getMarketStatsHistory(symbol, 1),
    ]);
  } catch {
    await ctx.reply(`Market "${symbol}" not found. Use /markets to browse.`);
    return;
  }

  const isolated = isIsolatedOnly(symbol);
  const oi = stats?.stats?.[0]?.open_interest;
  const oiStr = oi != null ? usd(Number(oi)) : "—";
  const apr = fundingApr(snapshot.fundingRate);
  const dir = fundingDir(snapshot.fundingRate);
  const absApr = Math.abs(snapshot.fundingRate * 1095 * 100);
  const fundingWarning =
    absApr > 100
      ? fmt`\n⚠️ Extreme funding rate — holding this position overnight is very expensive.`
      : fmt``;

  const isolatedNote = isolated
    ? fmt`\n\n${FormattedString.i("⚠️ Isolated margin only — standard trading not available yet.")}`
    : fmt``;

  const msg = fmt`📊 ${FormattedString.b(`${symbol}/USD`)}\n\nPrice         ${FormattedString.b(fmtPrice(snapshot.markPrice))}\n\nFunding       ${FormattedString.b(apr)}\n              ${FormattedString.i(dir)}${fundingWarning}\nOpen interest ${FormattedString.b(oiStr)}\n\nMax leverage  ${FormattedString.b(`${snapshot.maxLeverage}x`)}\nTaker fee     ${FormattedString.b(`${(snapshot.takerFee * 100).toFixed(2)}%`)}${isolatedNote}`;

  const kb = new InlineKeyboard();
  if (!isolated) {
    kb.text("🟢 Buy / Long", `trade:long:${symbol}`)
      .text("🔴 Sell / Short", `trade:short:${symbol}`)
      .row();
  }
  kb.text("🔔 Price alert", `pricealert:${symbol}`).text("← Markets", "markets:page:0");

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
