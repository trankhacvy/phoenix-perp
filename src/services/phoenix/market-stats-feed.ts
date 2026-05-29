import { logger } from "../../lib/logger.js";
import { getPhoenixWsClient } from "./client.js";

export interface MarketStatsLive {
  markPrice: number;
  oraclePrice: number;
  prevDayMarkPrice: number;
  dayVolumeUsd: number;
  openInterestBase: number;
  fundingHourPct: number;
  funding8hPct: number;
  fundingAnnualPct: number;
  updatedAt: number;
}

const stats = new Map<string, MarketStatsLive>();
let controller: AbortController | null = null;

export function getStats(symbol: string): MarketStatsLive | undefined {
  return stats.get(symbol.toUpperCase());
}

export function getAllStats(): ReadonlyMap<string, MarketStatsLive> {
  return stats;
}

export function getMarkPrice(symbol: string): number | undefined {
  return getStats(symbol)?.markPrice;
}

export function get24hChangePct(symbol: string): number | null {
  const s = getStats(symbol);
  if (!s || !s.prevDayMarkPrice) return null;
  return ((s.markPrice - s.prevDayMarkPrice) / s.prevDayMarkPrice) * 100;
}

export function getOpenInterestUsd(symbol: string): number | undefined {
  const s = getStats(symbol);
  return s ? s.openInterestBase * s.markPrice : undefined;
}

export function startAllMarketStats(): void {
  if (controller) return;
  const ac = new AbortController();
  controller = ac;

  void (async () => {
    for await (const update of getPhoenixWsClient().marketStats(undefined, ac.signal)) {
      const s = update.stats;
      stats.set(update.symbol.toUpperCase(), {
        markPrice: s.markPrice,
        oraclePrice: s.oraclePrice,
        prevDayMarkPrice: s.prevDayMarkPrice,
        dayVolumeUsd: s.dayVolumeUsd,
        openInterestBase: s.openInterest,
        fundingHourPct: s.currentFundingRate,
        funding8hPct: s.eightHourFundingRate,
        fundingAnnualPct: s.annualizedFundingRate,
        updatedAt: Date.now(),
      });
    }
  })().catch((err) => {
    if (err instanceof Error && err.name === "AbortError") return;
    logger.error({ err }, "all-markets marketStats subscription failed");
  });
}

export function stopMarketStatsFeed(): void {
  controller?.abort();
  controller = null;
  stats.clear();
}
