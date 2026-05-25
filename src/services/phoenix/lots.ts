import { BotError } from "../../bot/lib/errors.js";
import type { MarketSnapshot } from "./market.js";

export type MarketSizing = Pick<MarketSnapshot, "markPrice" | "baseLotsDecimals" | "symbol">;

export function marginToTokens(
  snap: MarketSizing,
  marginUsdc: number,
  leverage: number,
  priceOverride?: number,
): string {
  if (!Number.isFinite(marginUsdc) || marginUsdc <= 0) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "Invalid margin amount.",
    });
  }
  if (!Number.isFinite(leverage) || leverage < 1) {
    throw new BotError({
      category: "validation",
      code: "LEV_OUT_OF_RANGE",
      userMessage: "Invalid leverage.",
    });
  }
  const price =
    priceOverride !== undefined && Number.isFinite(priceOverride) && priceOverride > 0
      ? priceOverride
      : snap.markPrice;
  if (!price || price <= 0) {
    throw new BotError({
      category: "api",
      code: "UNKNOWN_MARKET",
      userMessage: `No price for ${snap.symbol}.`,
      hint: "Try /markets to browse available markets.",
    });
  }
  const tokens = (marginUsdc * leverage) / price;
  const minTokens = 10 ** -snap.baseLotsDecimals;
  if (tokens < minTokens) {
    throw new BotError({
      category: "validation",
      code: "SIZE_TOO_SMALL",
      userMessage: `Position too small for ${snap.symbol}.`,
      hint: `Minimum is ${minTokens.toFixed(snap.baseLotsDecimals)} ${snap.symbol}.`,
      meta: { tokens, minTokens },
    });
  }
  const factor = 10 ** snap.baseLotsDecimals;
  const rounded = Math.floor(tokens * factor) / factor;
  return rounded.toFixed(snap.baseLotsDecimals);
}

export function fractionToCloseLots(rawLots: number, fraction: number): bigint {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "Invalid close fraction.",
    });
  }
  const absLots = Math.abs(rawLots);
  const closeLots = fraction >= 1 ? absLots : Math.ceil(absLots * fraction);
  if (closeLots <= 0) {
    throw new BotError({
      category: "validation",
      code: "SIZE_TOO_SMALL",
      userMessage: "Position too small to close that fraction. Try closing 100% instead.",
      hint: "Use the full close button.",
    });
  }
  return BigInt(closeLots);
}

export function baseLotsToTokens(
  snap: Pick<MarketSnapshot, "baseLotsDecimals">,
  lots: number,
): number {
  return lots * 10 ** -snap.baseLotsDecimals;
}
