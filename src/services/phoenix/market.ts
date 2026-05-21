import type { ExchangeMarketConfig } from "@ellipsis-labs/rise";
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
}

export async function getMarkets(): Promise<ExchangeMarketConfig[]> {
  return getPhoenixClient().api.markets().getMarkets();
}

export async function getMarket(symbol: string): Promise<ExchangeMarketConfig> {
  return getPhoenixClient().api.markets().getMarket(symbol.toUpperCase());
}

export async function getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const [market, orderbook, fundingHistory] = await Promise.all([
    getMarket(symbol),
    getOrderbook(symbol),
    getPhoenixClient().api.funding().getFundingRateHistory(symbol.toUpperCase(), { limit: 1 }).catch(() => null),
  ]);

  const maxLeverage = market.leverageTiers.length > 0 ? market.leverageTiers[0].maxLeverage : 20;
  const fundingRate = fundingHistory?.rates?.[0]
    ? Number(fundingHistory.rates[0].fundingRatePercentage) / 100
    : 0;

  return {
    symbol: market.symbol,
    markPrice: orderbook.mid ?? 0,
    tickSize: market.tickSize,
    baseLotsDecimals: market.baseLotsDecimals,
    maxLeverage,
    takerFee: market.takerFee,
    makerFee: market.makerFee,
    fundingRate,
    openInterest: String(market.openInterestCapBaseLots),
    isIsolatedOnly: isIsolatedOnly(symbol),
  };
}

export async function getOrderbook(symbol: string) {
  return getPhoenixClient().api.orderbook().getOrderbook(symbol.toUpperCase());
}

export async function getFundingRateHistory(symbol: string, limit = 24) {
  return getPhoenixClient().api.funding().getFundingRateHistory(symbol.toUpperCase(), { limit });
}

export async function getMarketStatsHistory(symbol: string, limit = 1) {
  return getPhoenixClient().api.markets().getMarketStatsHistory(symbol.toUpperCase(), { limit }).catch(() => null);
}
