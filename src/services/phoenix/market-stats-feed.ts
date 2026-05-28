import { logger } from "../../lib/logger.js";
import { getPhoenixWsClient } from "./client.js";

export interface MarketStatsLive {
  markPrice: number;
  annualizedFunding: number;
  eightHourFunding: number;
  updatedAt: number;
}

const stats = new Map<string, MarketStatsLive>();
const controllers = new Map<string, AbortController>();

export function getStats(symbol: string): MarketStatsLive | undefined {
  return stats.get(symbol.toUpperCase());
}

export function ensureMarketStats(symbol: string): void {
  const key = symbol.toUpperCase();
  if (controllers.has(key)) return;
  const controller = new AbortController();
  controllers.set(key, controller);

  void (async () => {
    for await (const update of getPhoenixWsClient().marketStats(key, controller.signal)) {
      stats.set(key, {
        markPrice: update.stats.markPrice,
        annualizedFunding: update.stats.annualizedFundingRate,
        eightHourFunding: update.stats.eightHourFundingRate,
        updatedAt: Date.now(),
      });
    }
  })().catch((err) => {
    if (err instanceof Error && err.name === "AbortError") return;
    logger.error({ err, symbol: key }, "marketStats subscription failed");
  });
}

export function dropMarketStats(symbol: string): void {
  const key = symbol.toUpperCase();
  controllers.get(key)?.abort();
  controllers.delete(key);
  stats.delete(key);
}

export function syncMarketStats(symbols: Iterable<string>): void {
  const wanted = new Set<string>();
  for (const s of symbols) wanted.add(s.toUpperCase());
  for (const sym of wanted) ensureMarketStats(sym);
  for (const sym of [...controllers.keys()]) {
    if (!wanted.has(sym)) dropMarketStats(sym);
  }
}

export function stopMarketStatsFeed(): void {
  for (const [, controller] of controllers) controller.abort();
  controllers.clear();
  stats.clear();
}
