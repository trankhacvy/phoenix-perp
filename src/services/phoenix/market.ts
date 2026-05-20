import { config } from "../../config/index.js";

export const ISOLATED_ONLY_MARKETS = new Set(["GOLD", "SILVER", "SKR", "WTIOIL"]);

export function isIsolatedOnly(symbol: string): boolean {
  return ISOLATED_ONLY_MARKETS.has(symbol.toUpperCase());
}

export interface MarketSnapshot {
  markPrice: number;
  tickSize: number;
  baseLotSize: number;
  maxLeverage: number;
  fundingRate: number;
  openInterest: string;
  isIsolatedOnly: boolean;
}

export async function getMarkets() {
  const res = await fetch(`${config.PHOENIX_API_URL}/exchange/markets`);
  if (!res.ok) throw new Error(`Failed to fetch markets: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>[] | { markets: Record<string, unknown>[] }>;
}

export async function getMarket(symbol: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${config.PHOENIX_API_URL}/exchange/markets/${symbol}`);
  if (!res.ok) throw new Error(`Failed to fetch market ${symbol}: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

export async function getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const market = await getMarket(symbol);
  return {
    markPrice: Number(market.markPrice ?? 0),
    tickSize: Number(market.tickSize ?? 0.01),
    baseLotSize: Number(market.baseLotSize ?? 1),
    maxLeverage: Number(market.maxLeverage ?? 20),
    fundingRate: Number(market.fundingRate ?? 0),
    openInterest: String(market.openInterest ?? "0"),
    isIsolatedOnly: isIsolatedOnly(symbol),
  };
}

export async function getOrderbook(symbol: string) {
  const res = await fetch(`${config.PHOENIX_API_URL}/orderbook/${symbol}`);
  if (!res.ok) throw new Error(`Failed to fetch orderbook ${symbol}: ${res.status}`);
  return res.json();
}

export async function getFundingRateHistory(symbol: string, limit = 24) {
  const res = await fetch(
    `${config.PHOENIX_API_URL}/funding/history?symbol=${symbol}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch funding history: ${res.status}`);
  return res.json();
}
