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

export function fractionToCloseLots(rawLots: bigint, fraction: number): bigint {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "Invalid close fraction.",
    });
  }
  const absLots = rawLots < 0n ? -rawLots : rawLots;
  let closeLots: bigint;
  if (fraction >= 1) {
    closeLots = absLots;
  } else {
    const bps = BigInt(Math.round(fraction * 10_000)); // numfmt-ignore: UI fraction → integer bps, not a money amount
    const product = absLots * bps;
    closeLots = product / 10_000n + (product % 10_000n === 0n ? 0n : 1n);
  }
  if (closeLots <= 0n) {
    throw new BotError({
      category: "validation",
      code: "SIZE_TOO_SMALL",
      userMessage: "Position too small to close that fraction. Try closing 100% instead.",
      hint: "Use the full close button.",
    });
  }
  return closeLots;
}

export function baseLotsToTokens(
  snap: Pick<MarketSnapshot, "baseLotsDecimals">,
  lots: number,
): number {
  return lots * 10 ** -snap.baseLotsDecimals;
}
