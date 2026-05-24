import type { ExchangeMarketConfig } from "@ellipsis-labs/rise";
import { withRetry } from "../../lib/retry.js";
import { getPhoenixClient } from "./client.js";

export const ISOLATED_ONLY_MARKETS = new Set(["GOLD", "SILVER", "SKR", "WTIOIL"]);

export function isIsolatedOnly(symbol: string): boolean {
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

let _marketsCache: { data: ExchangeMarketConfig[]; ts: number } | null = null;
const MARKETS_TTL_MS = 60_000;

export async function getMarkets(): Promise<ExchangeMarketConfig[]> {
  if (_marketsCache && Date.now() - _marketsCache.ts < MARKETS_TTL_MS) return _marketsCache.data;
  const data = await getPhoenixClient().api.markets().getMarkets();
  _marketsCache = { data, ts: Date.now() };
  return data;
}

export async function getMarket(symbol: string): Promise<ExchangeMarketConfig> {
  return getPhoenixClient().api.markets().getMarket(symbol.toUpperCase());
}

const _snapshotCache = new Map<string, { data: MarketSnapshot; ts: number }>();
const SNAPSHOT_TTL_MS = 30_000;

export async function getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const key = symbol.toUpperCase();
  const cached = _snapshotCache.get(key);
  if (cached && Date.now() - cached.ts < SNAPSHOT_TTL_MS) return cached.data;

  const data = await withRetry(() => _getMarketSnapshot(symbol));
  _snapshotCache.set(key, { data, ts: Date.now() });
  return data;
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
  const results = await Promise.allSettled(
    markets.map((m) =>
      withRetry(async () => {
        const [orderbook, fundingHistory] = await Promise.all([
          getOrderbook(m.symbol),
          getPhoenixClient()
            .api.funding()
            .getFundingRateHistory(m.symbol.toUpperCase(), { limit: 1 })
            .catch(() => null),
        ]);
        const fundingRate = fundingHistory?.rates?.[0]
          ? Number(fundingHistory.rates[0].fundingRatePercentage) / 100
          : 0;
        return {
          symbol: m.symbol,
          markPrice: orderbook.mid ?? 0,
          fundingRate,
          maxLeverage: m.leverageTiers.length > 0 ? m.leverageTiers[0].maxLeverage : 20,
          isIsolatedOnly: isIsolatedOnly(m.symbol),
        };
      }),
    ),
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
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
  return getPhoenixClient().api.orderbook().getOrderbook(symbol.toUpperCase());
}

export async function getFundingRateHistory(symbol: string, limit = 24) {
  return getPhoenixClient().api.funding().getFundingRateHistory(symbol.toUpperCase(), { limit });
}

export async function getMarketStatsHistory(symbol: string, limit = 1) {
  return getPhoenixClient()
    .api.markets()
    .getMarketStatsHistory(symbol.toUpperCase(), { limit })
    .catch(() => null);
}
