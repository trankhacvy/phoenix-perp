import type { ExchangeMarketConfig } from "@ellipsis-labs/rise";
import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot, CallbackQueryContext } from "grammy";
import { InlineKeyboard } from "grammy";
import { getTaSnapshot } from "../../services/phoenix/candles.js";
import {
  getFundingRateHistory,
  getMarket,
  getMarketSnapshot,
  getMarketStatsHistory,
  getMarkets,
  isIsolatedOnly,
} from "../../services/phoenix/market.js";
import type { BotContext } from "../../types/index.js";
import { price as fmtPrice, fundingApr, fundingDir, fundingTrend, usd } from "../lib/fmt.js";
import { addPaginationRow, paginate } from "../lib/paginate.js";

const PAGE_SIZE = 10;

// ── List ──────────────────────────────────────────────────────────────────────

function buildListRow(
  m: ExchangeMarketConfig,
  snap: { markPrice: number; fundingRate: number; maxLeverage: number } | null,
  localIdx: number,
  page: number,
  botUsername: string,
): FormattedString {
  const deepLink = `https://t.me/${botUsername}?start=mkt_${m.symbol}_${page}`;
  const isoTag = isIsolatedOnly(m.symbol) ? " [ISO]" : "";
  const maxLev = snap?.maxLeverage ?? m.leverageTiers[0]?.maxLeverage ?? 20;
  const label = `${localIdx + 1}. ${m.symbol}${isoTag} · ${maxLev}x`;

  if (!snap) {
    return fmt`${FormattedString.link(label, deepLink)}   —`;
  }

  return fmt`${FormattedString.link(label, deepLink)}   ${FormattedString.b(fmtPrice(snap.markPrice))}  ${FormattedString.i(fundingApr(snap.fundingRate))}`;
}

async function sendMarketsPage(
  ctx: BotContext | CallbackQueryContext<BotContext>,
  page: number,
  edit: boolean,
): Promise<void> {
  const allMarkets = await getMarkets();
  const { items: slice, page: safePage, totalPages } = paginate(allMarkets, page, PAGE_SIZE);

  const snapshots = await Promise.allSettled(slice.map((m) => getMarketSnapshot(m.symbol)));

  const botUsername = ctx.me.username ?? "bot";

  const pageLabel =
    totalPages > 1 ? fmt`  ·  ${FormattedString.i(`Page ${safePage + 1}/${totalPages}`)}` : fmt``;
  const header = fmt`📊 ${FormattedString.b("Markets")}${pageLabel}`;

  const rows = slice.map((m, i) => {
    const snap = snapshots[i].status === "fulfilled" ? snapshots[i].value : null;
    return buildListRow(m, snap, i, safePage, botUsername);
  });

  const msg = FormattedString.join([header, "", ...rows], "\n");

  const kb = new InlineKeyboard();
  addPaginationRow(kb, "markets:page", safePage, totalPages);
  kb.text("🟢 Long", "nav:long").text("🔴 Short", "nav:short");

  const opts = {
    entities: msg.entities,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  };

  if (edit && "editMessageText" in ctx) {
    await (ctx as CallbackQueryContext<BotContext>).editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

// ── Detail ────────────────────────────────────────────────────────────────────

export async function sendMarketDetail(
  ctx: BotContext,
  symbol: string,
  fromPage: number,
  edit = false,
): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof getMarketSnapshot>>;
  let marketConfig: ExchangeMarketConfig;
  let stats: Awaited<ReturnType<typeof getMarketStatsHistory>>;
  let ta: Awaited<ReturnType<typeof getTaSnapshot>>;
  let fundingHistory: Awaited<ReturnType<typeof getFundingRateHistory>> | null;

  try {
    [snapshot, marketConfig, stats, ta, fundingHistory] = await Promise.all([
      getMarketSnapshot(symbol),
      getMarket(symbol),
      getMarketStatsHistory(symbol, 1),
      getTaSnapshot(symbol),
      getFundingRateHistory(symbol, 8).catch(() => null),
    ]);
  } catch {
    const text = `Market "${symbol}" not found. Use /markets to browse.`;
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text);
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const isolated = isIsolatedOnly(symbol);

  // Actual current OI from stats (not the cap stored in market config)
  const actualOI = stats?.stats?.[0]?.open_interest;
  const oiStr = actualOI != null ? usd(actualOI) : "—";

  const apr = fundingApr(snapshot.fundingRate);
  const dir = fundingDir(snapshot.fundingRate);
  const trend = fundingHistory?.rates
    ? fundingTrend(fundingHistory.rates.map((r) => Number(r.fundingRatePercentage) / 100))
    : "";
  const trendStr = trend ? ` ${trend}` : "";

  const absApr = Math.abs(snapshot.fundingRate * 1095 * 100);
  const fundingWarning =
    absApr > 100
      ? fmt`\n⚠️ ${FormattedString.i("Extreme funding — holding overnight is very expensive.")}`
      : fmt``;

  const isolatedNote = isolated
    ? fmt`\n\n${FormattedString.i("⚠️ Isolated margin only — standard trading not available yet.")}`
    : fmt``;

  // Commodity market status
  const commodityMeta = marketConfig.commodityMetadata;
  let commodityNote = fmt``;
  if (commodityMeta?.isCommodity) {
    if (commodityMeta.isAfterHours) {
      commodityNote = fmt`\n\n⏰ ${FormattedString.i("After-hours trading — reduced liquidity, wider spreads.")}`;
    } else if (commodityMeta.status && commodityMeta.status !== "open") {
      commodityNote = fmt`\n\n⚠️ ${FormattedString.i(`Market ${commodityMeta.status}`)}`;
    }
  }

  const taSection =
    ta.rsi !== null
      ? (() => {
          const rsiLabel = ta.rsi < 30 ? "Oversold 📉" : ta.rsi > 70 ? "Overbought 📈" : "Neutral";
          const macdLabel =
            ta.macdHist !== null ? (ta.macdHist > 0 ? "Bullish ↑" : "Bearish ↓") : "";
          const bbStr =
            ta.bbUpperBand != null && ta.bbLowerBand != null
              ? `${fmtPrice(ta.bbLowerBand)} – ${fmtPrice(ta.bbUpperBand)}`
              : "";
          const atrStr = ta.atr != null ? fmtPrice(ta.atr) : "";
          return fmt`\n\n📈 ${FormattedString.b("Indicators (1H)")}\nRSI(14)    ${FormattedString.b(ta.rsi.toFixed(1))}  ${FormattedString.i(rsiLabel)}\nMACD       ${FormattedString.i(macdLabel)}\nBollinger  ${FormattedString.b(bbStr)}\nATR(14)    ${FormattedString.b(atrStr)}`;
        })()
      : fmt``;

  const msg = fmt`📊 ${FormattedString.b(`${symbol}/USD`)}  ·  ${FormattedString.b(`${snapshot.maxLeverage}x`)}\n\nPrice    ${FormattedString.b(fmtPrice(snapshot.markPrice))}\nOI       ${FormattedString.b(oiStr)}\n\nFunding  ${FormattedString.b(apr)}\n         ${FormattedString.i(`${dir}${trendStr}`)}${fundingWarning}\n\nFee      ${FormattedString.b(`${(snapshot.takerFee * 100).toFixed(2)}%`)}${isolatedNote}${commodityNote}${taSection}`;

  const kb = new InlineKeyboard();
  if (!isolated) {
    kb.text("🟢 Buy / Long", `trade:long:${symbol}`)
      .text("🔴 Sell / Short", `trade:short:${symbol}`)
      .row();
  }
  kb.text("🔔 Price alert", `pricealert:${symbol}`).text("← Markets", `markets:page:${fromPage}`);

  const opts = { entities: msg.entities, reply_markup: kb };

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerMarkets(bot: Bot<BotContext>) {
  bot.command("markets", async (ctx) => {
    await sendMarketsPage(ctx, 0, false);
  });

  bot.command("market", async (ctx) => {
    const symbol = ctx.match?.trim().toUpperCase();
    if (!symbol) {
      await ctx.reply("Usage: /market SOL\n\nOr use /markets to browse all markets.");
      return;
    }
    await sendMarketDetail(ctx, symbol, 0, false);
  });

  bot.callbackQuery(/^markets:page:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = Number(ctx.match[1]);
    await sendMarketsPage(ctx, page, true);
  });

  bot.callbackQuery(/^market:detail:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const symbol = ctx.match[1];
    const fromPage = Number(ctx.match[2]);
    await sendMarketDetail(ctx, symbol, fromPage, true);
  });
}
