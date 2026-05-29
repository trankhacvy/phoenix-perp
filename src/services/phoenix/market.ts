import type { ExchangeConfig, ExchangeMarketConfig } from "@ellipsis-labs/rise";
import { withRetry } from "../../lib/retry.js";
import { getPhoenixClient } from "./client.js";
import { acquirePhoenixRest } from "./rest-limit.js";

export const ISOLATED_ONLY_MARKETS = new Set(["GOLD", "SILVER", "SKR", "WTIOIL"]);

let _exchangeCache: { data: ExchangeConfig; ts: number } | null = null;
const EXCHANGE_TTL_MS = 5 * 60_000;

export async function getExchangeConfig(): Promise<ExchangeConfig> {
  if (_exchangeCache && Date.now() - _exchangeCache.ts < EXCHANGE_TTL_MS) {
    return _exchangeCache.data;
  }
  try {
    const data = await withRetry(async () => {
      await acquirePhoenixRest();
      return getPhoenixClient().api.exchange().getExchange();
    });
    _exchangeCache = { data, ts: Date.now() };
    return data;
  } catch (err) {
    if (_exchangeCache) return _exchangeCache.data;
    throw err;
  }
}

export async function getMarkets(): Promise<ExchangeMarketConfig[]> {
  const exchange = await getExchangeConfig();

  return exchange.markets;
}

export async function getMarket(symbol: string): Promise<ExchangeMarketConfig> {
  const markets = await getMarkets();
  const upper = symbol.toUpperCase();
  const found = markets.find((m) => m.symbol === upper);
  if (!found) throw new Error(`Market ${upper} not found`);
  return found;
}

export function isIsolatedOnly(symbol: string): boolean {
  if (_exchangeCache) {
    const market = _exchangeCache.data.markets.find((m) => m.symbol === symbol.toUpperCase());
    if (market) return market.isolatedOnly;
  }
  return ISOLATED_ONLY_MARKETS.has(symbol.toUpperCase());
}

export interface MarketSnapshot {
  markPrice: number;
  tickSize: number;
  baseLotsDecimals: number;
  maxLeverage: number;
  takerFee: number;
  makerFee: number;
  fundingRate: number;
  openInterest: string;
  isIsolatedOnly: boolean;
  symbol: string;
  leverageTiers: Array<{ maxLeverage: number; maxNotionalUsdc: number }>;
}

export interface MarketListItem {
  symbol: string;
  markPrice: number;
  fundingRate: number;
  maxLeverage: number;
  isIsolatedOnly: boolean;
}

const _snapshotCache = new Map<string, { data: MarketSnapshot; ts: number }>();
const SNAPSHOT_TTL_MS = 30_000;

export async function getMarketSnapshot(
  symbol: string,
  opts?: { skipCache?: boolean },
): Promise<MarketSnapshot> {
  const key = symbol.toUpperCase();
  const cached = _snapshotCache.get(key);
  if (!opts?.skipCache && cached && Date.now() - cached.ts < SNAPSHOT_TTL_MS) {
    return cached.data;
  }

  try {
    const data = await withRetry(() => _getMarketSnapshot(symbol));
    _snapshotCache.set(key, { data, ts: Date.now() });
    return data;
  } catch (err) {
    if (cached) return cached.data;
    throw err;
  }
}

async function _getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const [market, orderbook, fundingHistory] = await Promise.all([
    getMarket(symbol),
    getOrderbook(symbol),
    getPhoenixClient()
      .api.funding()
      .getFundingRateHistory(symbol.toUpperCase(), { limit: 1 })
      .catch(() => null),
  ]);

  const maxLeverage = market.leverageTiers.length > 0 ? market.leverageTiers[0].maxLeverage : 20;
  const fundingRate = fundingHistory?.rates?.[0]
    ? Number(fundingHistory.rates[0].fundingRatePercentage) / 100
    : 0;
  const markPrice = orderbook.mid ?? 0;
  const lotToBase = 10 ** -market.baseLotsDecimals;
  const leverageTiers = market.leverageTiers.map((t) => ({
    maxLeverage: t.maxLeverage,
    maxNotionalUsdc: t.maxSizeBaseLots * lotToBase * markPrice,
  }));

  return {
    symbol: market.symbol,
    markPrice,
    tickSize: market.tickSize,
    baseLotsDecimals: market.baseLotsDecimals,
    maxLeverage,
    takerFee: market.takerFee,
    makerFee: market.makerFee,
    fundingRate,
    openInterest: String(market.openInterestCapBaseLots),
    isIsolatedOnly: isIsolatedOnly(symbol),
    leverageTiers,
  };
}

export async function getMarketListItems(
  markets: ExchangeMarketConfig[],
): Promise<MarketListItem[]> {
  const results = await Promise.allSettled(markets.map((m) => getMarketSnapshot(m.symbol)));
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? {
          symbol: r.value.symbol,
          markPrice: r.value.markPrice,
          fundingRate: r.value.fundingRate,
          maxLeverage: r.value.maxLeverage,
          isIsolatedOnly: r.value.isIsolatedOnly,
        }
      : {
          symbol: markets[i].symbol,
          markPrice: 0,
          fundingRate: 0,
          maxLeverage:
            markets[i].leverageTiers.length > 0 ? markets[i].leverageTiers[0].maxLeverage : 20,
          isIsolatedOnly: isIsolatedOnly(markets[i].symbol),
        },
  );
}

export async function getOrderbook(symbol: string) {
  await acquirePhoenixRest();
  return getPhoenixClient().api.orderbook().getOrderbook(symbol.toUpperCase());
}

export async function getFundingRateHistory(symbol: string, limit = 24) {
  await acquirePhoenixRest();
  return getPhoenixClient().api.funding().getFundingRateHistory(symbol.toUpperCase(), { limit });
}

export async function getMarketStatsHistory(symbol: string, limit = 1) {
  await acquirePhoenixRest();
  return getPhoenixClient()
    .api.markets()
    .getMarketStatsHistory(symbol.toUpperCase(), { limit })
    .catch(() => null);
}
