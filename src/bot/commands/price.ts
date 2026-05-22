import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  getFundingRateHistory,
  getMarketSnapshot,
  getMarketStatsHistory,
  isIsolatedOnly,
} from "../../services/phoenix/market.js";
import { getTaSnapshot } from "../../services/phoenix/candles.js";
import type { BotContext } from "../../types/index.js";
import { price as fmtPrice, fundingApr, fundingDir, fundingTrend, usd } from "../lib/fmt.js";

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
  let ta: Awaited<ReturnType<typeof getTaSnapshot>>;
  let fundingHistory: Awaited<ReturnType<typeof getFundingRateHistory>> | null;
  try {
    [snapshot, stats, ta, fundingHistory] = await Promise.all([
      getMarketSnapshot(symbol),
      getMarketStatsHistory(symbol, 1),
      getTaSnapshot(symbol),
      getFundingRateHistory(symbol, 8).catch(() => null),
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
  const trend = fundingHistory?.rates
    ? fundingTrend(fundingHistory.rates.map((r) => Number(r.fundingRatePercentage) / 100))
    : "";
  const absApr = Math.abs(snapshot.fundingRate * 1095 * 100);
  const fundingWarning =
    absApr > 100
      ? fmt`\n⚠️ Extreme funding rate — holding this position overnight is very expensive.`
      : fmt``;

  const isolatedNote = isolated
    ? fmt`\n\n${FormattedString.i("⚠️ Isolated margin only — standard trading not available yet.")}`
    : fmt``;

  const taSection =
    ta.rsi !== null
      ? (() => {
          const rsiLabel =
            ta.rsi < 30 ? "Oversold 📉" : ta.rsi > 70 ? "Overbought 📈" : "Neutral";
          const macdLabel =
            ta.macdHist !== null
              ? ta.macdHist > 0
                ? "Bullish ↑"
                : "Bearish ↓"
              : "";
          const bbStr =
            ta.bbUpperBand != null && ta.bbLowerBand != null
              ? `${fmtPrice(ta.bbLowerBand)} – ${fmtPrice(ta.bbUpperBand)}`
              : "";
          const atrStr = ta.atr != null ? fmtPrice(ta.atr) : "";
          return fmt`\n\n📈 ${FormattedString.b("Indicators (1H)")}\nRSI(14)    ${FormattedString.b(ta.rsi.toFixed(1))}  ${FormattedString.i(rsiLabel)}\nMACD       ${FormattedString.i(macdLabel)}\nBollinger  ${FormattedString.b(bbStr)}\nATR(14)    ${FormattedString.b(atrStr)}`;
        })()
      : fmt``;

  const trendStr = trend ? ` ${trend}` : "";
  const msg = fmt`📊 ${FormattedString.b(`${symbol}/USD`)}\n\nPrice         ${FormattedString.b(fmtPrice(snapshot.markPrice))}\n\nFunding       ${FormattedString.b(apr)}\n              ${FormattedString.i(`${dir}${trendStr}`)}${fundingWarning}\nOpen interest ${FormattedString.b(oiStr)}\n\nMax leverage  ${FormattedString.b(`${snapshot.maxLeverage}x`)}\nTaker fee     ${FormattedString.b(`${(snapshot.takerFee * 100).toFixed(2)}%`)}${isolatedNote}${taSection}`;

  const kb = new InlineKeyboard();
  if (!isolated) {
    kb.text("🟢 Buy / Long", `trade:long:${symbol}`)
      .text("🔴 Sell / Short", `trade:short:${symbol}`)
      .row();
  }
  kb.text("🔔 Price alert", `pricealert:${symbol}`).text("← Markets", "markets:page:0");

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
