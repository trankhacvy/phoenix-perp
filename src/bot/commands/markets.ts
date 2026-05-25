import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot, CallbackQueryContext } from "grammy";
import { InlineKeyboard } from "grammy";
import { getTaSnapshot } from "../../services/phoenix/candles.js";
import {
  type MarketListItem,
  getFundingRateHistory,
  getMarket,
  getMarketListItems,
  getMarketSnapshot,
  getMarketStatsHistory,
  getMarkets,
  isIsolatedOnly,
} from "../../services/phoenix/market.js";
import type { BotContext } from "../../types/index.js";
import {
  price as fmtPrice,
  funding1h,
  fundingDailyUsd,
  fundingDir,
  fundingDot,
  fundingTrend,
  usd,
} from "../lib/fmt.js";
import { addPaginationRow, paginate } from "../lib/paginate.js";

const PAGE_SIZE = 10;

// ── List ──────────────────────────────────────────────────────────────────────

function buildListRow(
  item: MarketListItem,
  index: number,
  botUsername: string,
  page: number,
): FormattedString {
  const iso = item.isIsolatedOnly ? " [ISO]" : "";
  const priceStr = item.markPrice > 0 ? fmtPrice(item.markPrice) : "—";
  const dot = fundingDot(item.fundingRate);
  const rate = funding1h(item.fundingRate);
  const deepLink = `https://t.me/${botUsername}?start=mkt_${item.symbol}_${page}`;
  const label = `${index}. ${item.symbol}${iso}`;

  return fmt`${FormattedString.link(label, deepLink)}  ${FormattedString.b(priceStr)}
  Leverage: ${FormattedString.b(String(item.maxLeverage))}  ·  Funding: ${rate} ${dot}`;
}

export async function sendMarketsScreen(ctx: BotContext | CallbackQueryContext<BotContext>) {
  return sendMarketsPage(ctx, 0, false);
}

async function sendMarketsPage(
  ctx: BotContext | CallbackQueryContext<BotContext>,
  page: number,
  edit: boolean,
): Promise<void> {
  const allMarkets = await getMarkets();
  const { items: slice, page: safePage, totalPages } = paginate(allMarkets, page, PAGE_SIZE);

  const listItems = await getMarketListItems(slice);
  const botUsername = ctx.me.username ?? "bot";

  const pageLabel =
    totalPages > 1 ? fmt`  ·  ${FormattedString.i(`${safePage + 1}/${totalPages}`)}` : fmt``;
  const header = fmt`📊 ${FormattedString.b("Markets")}${pageLabel}\n`;

  const rows = listItems.map((item, i) => {
    const globalIdx = safePage * PAGE_SIZE + i + 1;
    return buildListRow(item, globalIdx, botUsername, safePage);
  });

  const footer = fmt`\n${FormattedString.i("Tap a market name for details & trading.")}`;

  const msg = FormattedString.join([header, ...rows, footer], "\n");

  const kb = new InlineKeyboard();
  addPaginationRow(kb, "markets:page", safePage, totalPages);

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
  let stats: Awaited<ReturnType<typeof getMarketStatsHistory>>;
  let ta: Awaited<ReturnType<typeof getTaSnapshot>>;
  let fundingHistory: Awaited<ReturnType<typeof getFundingRateHistory>> | null;
  let commodityMetadata: { isCommodity?: boolean; isAfterHours?: boolean; status?: string } | null;

  try {
    const [snapshotRes, marketConfig, statsRes, taRes, fundingRes] = await Promise.all([
      getMarketSnapshot(symbol),
      getMarket(symbol),
      getMarketStatsHistory(symbol, 1),
      getTaSnapshot(symbol),
      getFundingRateHistory(symbol, 8).catch(() => null),
    ]);
    snapshot = snapshotRes;
    stats = statsRes;
    ta = taRes;
    fundingHistory = fundingRes;
    commodityMetadata = marketConfig.commodityMetadata ?? null;
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

  const actualOI = stats?.stats?.[0]?.open_interest;
  const oiStr = actualOI != null ? usd(actualOI) : "—";

  const rate1h = funding1h(snapshot.fundingRate);
  const dir = fundingDir(snapshot.fundingRate);
  const trend = fundingHistory?.rates
    ? fundingTrend(fundingHistory.rates.map((r) => Number(r.fundingRatePercentage) / 100))
    : "";
  const trendStr = trend ? ` ${trend}` : "";
  const dot = fundingDot(snapshot.fundingRate);
  const dailyCost = fundingDailyUsd(snapshot.fundingRate, 10_000);

  const abs1h = Math.abs(snapshot.fundingRate * 100);
  const fundingWarning =
    abs1h > 0.01
      ? fmt`\n   ⚠️ ${FormattedString.i("Extreme — holding overnight is costly")}`
      : fmt``;

  const isolatedNote = isolated
    ? fmt`\n\n⚠️ ${FormattedString.i("Isolated margin only — not available for cross-margin trading.")}`
    : fmt``;

  let commodityNote = fmt``;
  if (commodityMetadata?.isCommodity) {
    if (commodityMetadata.isAfterHours) {
      commodityNote = fmt`\n\n⏰ ${FormattedString.i("After-hours — reduced liquidity, wider spreads.")}`;
    } else if (commodityMetadata.status && commodityMetadata.status !== "open") {
      commodityNote = fmt`\n\n⚠️ ${FormattedString.i(`Market ${commodityMetadata.status}`)}`;
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
          return fmt`\n\n📈 ${FormattedString.b("Technicals (1H)")}\n   RSI(14)    ${FormattedString.b(ta.rsi.toFixed(1))} · ${FormattedString.i(rsiLabel)}\n   MACD       ${FormattedString.i(macdLabel)}\n   Bollinger  ${FormattedString.b(bbStr)}\n   ATR(14)    ${FormattedString.b(atrStr)}`;
        })()
      : fmt``;

  const msg = fmt`📊 ${FormattedString.b(symbol)}\n\n💰 Price          ${FormattedString.b(fmtPrice(snapshot.markPrice))}\n📏 Leverage       ${FormattedString.b(String(snapshot.maxLeverage))} max\n📊 Open interest  ${FormattedString.b(oiStr)}\n\n💸 ${FormattedString.b("1h Funding")}\n   Rate     ${FormattedString.b(rate1h)}${trendStr} ${dot}\n   Pays     ${FormattedString.i(dir)}\n   Daily    ${FormattedString.i(`~${dailyCost} per $10K`)}${fundingWarning}\n\n💰 Fee  ${FormattedString.b(`${(snapshot.takerFee * 100).toFixed(2)}%`)} taker${isolatedNote}${commodityNote}${taSection}`;

  const kb = new InlineKeyboard();
  if (!isolated) {
    kb.text("🟢 Long", `trade:long:${symbol}`).text("🔴 Short", `trade:short:${symbol}`).row();
  }
  kb.text("🔔 Price alert", `pricealert:${symbol}`).text("← Markets", `markets:page:${fromPage}`);

  const opts = {
    entities: msg.entities,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  };

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
