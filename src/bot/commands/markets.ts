import type { ExchangeMarketConfig } from "@ellipsis-labs/rise";
import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot, CallbackQueryContext } from "grammy";
import { InlineKeyboard } from "grammy";
import { getTaSnapshot } from "../../services/phoenix/candles.js";
import { type MarketStatsLive, getStats } from "../../services/phoenix/market-stats-feed.js";
import {
  getMarket,
  getMarketStatsHistory,
  getMarkets,
  isIsolatedOnly,
} from "../../services/phoenix/market.js";
import type { BotContext } from "../../types/index.js";
import {
  change24h,
  compactUsd,
  price as fmtPrice,
  fundingAnnual,
  fundingDotAnnual,
  fundingHourly,
  money,
  num,
  percentAbs,
  pnlEmoji,
} from "../lib/fmt.js";
import { addPaginationRow, paginate } from "../lib/paginate.js";

const PAGE_SIZE = 10;

type SortKey = "vol" | "funding" | "chg";

const SORT_LABELS: Record<SortKey, string> = {
  vol: "24h volume",
  funding: "funding",
  chg: "24h movers",
};

function parseSort(raw: string | undefined): SortKey {
  return raw === "funding" || raw === "chg" ? raw : "vol";
}

function maxLeverageOf(cfg: ExchangeMarketConfig): number {
  return cfg.leverageTiers.length > 0 ? cfg.leverageTiers[0].maxLeverage : 20;
}

function change24hPctOf(stat: MarketStatsLive | undefined): number | null {
  if (!stat || !stat.prevDayMarkPrice) return null;
  return ((stat.markPrice - stat.prevDayMarkPrice) / stat.prevDayMarkPrice) * 100;
}

function sortMarkets(markets: ExchangeMarketConfig[], sort: SortKey): ExchangeMarketConfig[] {
  const scored = markets.map((cfg) => {
    const stat = getStats(cfg.symbol);
    let score = 0;
    if (sort === "vol") score = stat?.dayVolumeUsd ?? 0;
    else if (sort === "funding") score = stat ? Math.abs(stat.fundingAnnualPct) : 0;
    else score = Math.abs(change24hPctOf(stat) ?? 0);
    return { cfg, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cfg);
}

// ── List ──────────────────────────────────────────────────────────────────────

function buildListRow(
  cfg: ExchangeMarketConfig,
  index: number,
  botUsername: string,
  page: number,
  sort: SortKey,
): FormattedString {
  const stat = getStats(cfg.symbol);
  const iso = cfg.isolatedOnly ? " ⊙" : "";
  const priceStr = stat ? fmtPrice(stat.markPrice) : "—";

  const chgPct = change24hPctOf(stat);
  const chgStr = chgPct !== null ? `${pnlEmoji(chgPct)} ${change24h(chgPct)}` : "—";

  const fundingStr = stat
    ? `${fundingHourly(stat.fundingHourPct)} ${fundingDotAnnual(stat.fundingAnnualPct)}`
    : "—";

  const deepLink = `https://t.me/${botUsername}?start=mkt_${cfg.symbol}_${page}_${sort}`;
  const label = `${index}. ${cfg.symbol}${iso}`;

  return fmt`${FormattedString.link(label, deepLink)}    ${FormattedString.b(priceStr)}    ${chgStr}
     ${FormattedString.b(`${maxLeverageOf(cfg)}x`)}   ·   1h funding  ${fundingStr}`;
}

function sortRow(kb: InlineKeyboard, active: SortKey): void {
  const btn = (key: SortKey, label: string) =>
    kb.text(active === key ? `• ${label}` : label, `markets:sort:${key}`);
  btn("vol", "🔥 Volume");
  btn("funding", "💸 Funding");
  btn("chg", "📈 Movers");
  kb.row();
}

export async function sendMarketsScreen(ctx: BotContext | CallbackQueryContext<BotContext>) {
  return sendMarketsPage(ctx, 0, "vol", false);
}

async function sendMarketsPage(
  ctx: BotContext | CallbackQueryContext<BotContext>,
  page: number,
  sort: SortKey,
  edit: boolean,
): Promise<void> {
  const allMarkets = await getMarkets();
  const sorted = sortMarkets(allMarkets, sort);
  const { items: slice, page: safePage, totalPages } = paginate(sorted, page, PAGE_SIZE);

  const botUsername = ctx.me.username ?? "bot";

  const pageLabel =
    totalPages > 1 ? fmt`  ·  ${FormattedString.i(`${safePage + 1}/${totalPages}`)}` : fmt``;
  const header = fmt`📊 ${FormattedString.b("Markets")}  ${FormattedString.i(`by ${SORT_LABELS[sort]}`)}${pageLabel}\n`;

  const rows = slice.map((cfg, i) => {
    const globalIdx = safePage * PAGE_SIZE + i + 1;
    return buildListRow(cfg, globalIdx, botUsername, safePage, sort);
  });

  const footer = fmt`\n${FormattedString.i("⊙ isolated-only · tap a market for details")}`;
  const body = FormattedString.join(rows, "\n\n");
  const msg = FormattedString.join([header, body, footer], "\n");

  const kb = new InlineKeyboard();
  sortRow(kb, sort);
  addPaginationRow(kb, `markets:page:${sort}`, safePage, totalPages);

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

interface DetailStats {
  markPrice: number;
  oraclePrice: number | null;
  change24hPct: number | null;
  dayVolumeUsd: number | null;
  openInterestUsd: number | null;
  fundingHourPct: number | null;
  fundingAnnualPct: number | null;
  live: boolean;
}

async function resolveDetailStats(symbol: string): Promise<DetailStats | null> {
  const stat = getStats(symbol);
  if (stat) {
    return {
      markPrice: stat.markPrice,
      oraclePrice: stat.oraclePrice,
      change24hPct: change24hPctOf(stat),
      dayVolumeUsd: stat.dayVolumeUsd,
      openInterestUsd: stat.openInterestBase * stat.markPrice,
      fundingHourPct: stat.fundingHourPct,
      fundingAnnualPct: stat.fundingAnnualPct,
      live: true,
    };
  }

  // Cold-start fallback: history gives mark + OI (no volume/funding).
  const history = await getMarketStatsHistory(symbol, 1).catch(() => null);
  const point = history?.stats?.[0];
  if (!point) return null;
  return {
    markPrice: point.mark_price,
    oraclePrice: point.spot_price ?? null,
    change24hPct: null,
    dayVolumeUsd: null,
    openInterestUsd: point.open_interest * point.mark_price,
    fundingHourPct: null,
    fundingAnnualPct: null,
    live: false,
  };
}

export async function sendMarketDetail(
  ctx: BotContext,
  symbol: string,
  fromPage: number,
  sort: SortKey = "vol",
  edit = false,
): Promise<void> {
  let marketConfig: ExchangeMarketConfig;
  let detail: DetailStats | null;
  try {
    [marketConfig, detail] = await Promise.all([getMarket(symbol), resolveDetailStats(symbol)]);
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
  const maxLev = maxLeverageOf(marketConfig);

  const priceStr = detail ? fmtPrice(detail.markPrice) : "—";
  const indexStr = detail?.oraclePrice ? fmtPrice(detail.oraclePrice) : "—";

  const chgLine =
    detail?.change24hPct !== null && detail?.change24hPct !== undefined
      ? fmt`${pnlEmoji(detail.change24hPct)} ${change24h(detail.change24hPct)}`
      : fmt`—`;
  const volStr =
    detail?.dayVolumeUsd !== null && detail?.dayVolumeUsd !== undefined
      ? compactUsd(detail.dayVolumeUsd)
      : "—";
  const oiStr =
    detail?.openInterestUsd !== null && detail?.openInterestUsd !== undefined
      ? compactUsd(detail.openInterestUsd)
      : "—";

  let fundingBlock: FormattedString;
  if (detail?.fundingHourPct !== null && detail?.fundingHourPct !== undefined) {
    const hour = detail.fundingHourPct;
    const annual = detail.fundingAnnualPct ?? hour * 8760;
    const dir = hour >= 0 ? "Longs pay shorts" : "Shorts pay longs";
    const dot = fundingDotAnnual(annual);
    const dailyPer10k = (Math.abs(annual) / 100 / 365) * 10_000;
    fundingBlock = fmt`💸 ${FormattedString.b("Funding")} (1h)   ${FormattedString.b(fundingHourly(hour))}  ${dot} ${FormattedString.i(dir)}
   Annualized   ${FormattedString.b(fundingAnnual(annual))}
   Cost         ${FormattedString.i(`~${money(dailyPer10k)} / day per $10k`)}`;
  } else {
    fundingBlock = fmt`💸 ${FormattedString.b("Funding")}   ${FormattedString.i("warming up…")}`;
  }

  const isolatedNote = isolated
    ? fmt`\n\n⚠️ ${FormattedString.i("Isolated margin only — not available for cross-margin trading.")}`
    : fmt``;

  const commodity = marketConfig.commodityMetadata;
  let commodityNote = fmt``;
  if (commodity?.isCommodity) {
    if (commodity.isAfterHours) {
      commodityNote = fmt`\n\n⏰ ${FormattedString.i("After-hours — reduced liquidity, wider spreads.")}`;
    } else if (commodity.status && commodity.status !== "open") {
      commodityNote = fmt`\n\n⚠️ ${FormattedString.i(`Market ${commodity.status}`)}`;
    }
  }

  const coldNote =
    detail && !detail.live
      ? fmt`\n\n${FormattedString.i("Live data warming up — tap ↻ Refresh in a moment.")}`
      : fmt``;

  const takerPct = percentAbs(marketConfig.takerFee * 100, 3);
  const makerPct = percentAbs(marketConfig.makerFee * 100, 3);

  const msg = fmt`📊 ${FormattedString.b(symbol)}  ·  ${FormattedString.b(`${maxLev}x`)} max
━━━━━━━━━━━━━━━━━━━━━━━━━
Mark    ${FormattedString.b(priceStr)}  ${FormattedString.i("price for PnL, liquidations & TP/SL")}
Index   ${FormattedString.b(indexStr)}  ${FormattedString.i("oracle ref for funding")}
24h     ${chgLine}  ·  Vol ${FormattedString.b(volStr)}
OI      ${FormattedString.b(oiStr)}
━━━━━━━━━━━━━━━━━━━━━━━━━
${fundingBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━
Fees    ${FormattedString.b(takerPct)} taker · ${FormattedString.b(makerPct)} maker${isolatedNote}${commodityNote}${coldNote}`;

  const kb = new InlineKeyboard();
  if (!isolated) {
    kb.text("🟢 Long", `trade:long:${symbol}`).text("🔴 Short", `trade:short:${symbol}`).row();
  }
  kb.text("🔔 Price alert", `pricealert:${symbol}`)
    .text("📈 Technicals", `market:ta:${symbol}:${fromPage}`)
    .row();
  kb.text("↻ Refresh", `market:detail:${symbol}:${fromPage}`).text(
    "← Markets",
    `markets:page:${sort}:${fromPage}`,
  );

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

// ── Technicals (lazy — only fetched on demand) ──────────────────────────────────

async function sendMarketTa(ctx: BotContext, symbol: string, fromPage: number): Promise<void> {
  const ta = await getTaSnapshot(symbol).catch(() => null);

  let body: FormattedString;
  if (!ta || ta.rsi === null) {
    body = fmt`${FormattedString.i("Not enough candle history for indicators yet.")}`;
  } else {
    const rsiLabel = ta.rsi < 30 ? "Oversold 📉" : ta.rsi > 70 ? "Overbought 📈" : "Neutral";
    const macdLabel = ta.macdHist !== null ? (ta.macdHist > 0 ? "Bullish ↑" : "Bearish ↓") : "—";
    const bbStr =
      ta.bbUpperBand !== null && ta.bbLowerBand !== null
        ? `${fmtPrice(ta.bbLowerBand)} – ${fmtPrice(ta.bbUpperBand)}`
        : "—";
    const atrStr = ta.atr !== null ? fmtPrice(ta.atr) : "—";
    body = fmt`RSI(14)    ${FormattedString.b(num(ta.rsi, 1, 1))} · ${FormattedString.i(rsiLabel)}
MACD       ${FormattedString.i(macdLabel)}
Bollinger  ${FormattedString.b(bbStr)}
ATR(14)    ${FormattedString.b(atrStr)}`;
  }

  const msg = fmt`📈 ${FormattedString.b(`${symbol} — Technicals (1H)`)}
━━━━━━━━━━━━━━━━━━━━━━━━━
${body}`;

  const kb = new InlineKeyboard().text("← Back to market", `market:detail:${symbol}:${fromPage}`);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  } else {
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  }
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerMarkets(bot: Bot<BotContext>) {
  bot.command("markets", async (ctx) => {
    await sendMarketsPage(ctx, 0, "vol", false);
  });

  bot.command("market", async (ctx) => {
    const symbol = ctx.match?.trim().toUpperCase();
    if (!symbol) {
      await ctx.reply("Usage: /market SOL\n\nOr use /markets to browse all markets.");
      return;
    }
    await sendMarketDetail(ctx, symbol, 0, "vol", false);
  });

  bot.callbackQuery(/^markets:page:(vol|funding|chg):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const sort = parseSort(ctx.match[1]);
    const page = Number(ctx.match[2]);
    await sendMarketsPage(ctx, page, sort, true);
  });

  bot.callbackQuery(/^markets:sort:(vol|funding|chg)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendMarketsPage(ctx, 0, parseSort(ctx.match[1]), true);
  });

  bot.callbackQuery(/^market:detail:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const symbol = ctx.match[1];
    const fromPage = Number(ctx.match[2]);
    await sendMarketDetail(ctx, symbol, fromPage, "vol", true);
  });

  bot.callbackQuery(/^market:ta:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const symbol = ctx.match[1];
    const fromPage = Number(ctx.match[2]);
    await sendMarketTa(ctx, symbol, fromPage);
  });
}
