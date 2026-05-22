import { eq } from "drizzle-orm";
import { BotError } from "../../bot/lib/errors.js";
import { config } from "../../config/index.js";
import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/index.js";
import type { User } from "../../db/schema/users.js";
import { type MarketSnapshot, getMarketSnapshot, isIsolatedOnly } from "./market.js";
import { getTraderState } from "./position.js";

export interface PreflightInput {
  user: User;
  symbol: string;
  side: "long" | "short";
  marginUsdc: number;
  leverage: number;
  anchorPrice?: number;
}

export interface PreflightResult {
  snapshot: MarketSnapshot;
  effectiveLeverage: number;
  notional: number;
  feeUsdc: number;
  availableCollateral: number;
  liqPrice: number;
  totalCost: number;
}

const DEFAULT_SLIPPAGE_BPS = 50;

export async function preflightOpen(input: PreflightInput): Promise<PreflightResult> {
  const { user, symbol, side, marginUsdc, leverage, anchorPrice } = input;

  if (!user.phoenixActivated) {
    throw new BotError({
      category: "auth",
      code: "PHOENIX_NOT_ACTIVATED",
      userMessage: "Your Phoenix account isn't activated.",
      hint: "Run /start to finish setup.",
    });
  }

  if (isIsolatedOnly(symbol)) {
    throw new BotError({
      category: "validation",
      code: "ISOLATED_ONLY_MARKET",
      userMessage: `${symbol.toUpperCase()} requires isolated margin.`,
      hint: "Isolated margin support coming soon. Try /markets for available markets.",
    });
  }

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
      userMessage: "Leverage must be at least 1x.",
    });
  }

  let snapshot: MarketSnapshot;
  try {
    snapshot = await getMarketSnapshot(symbol);
  } catch (e) {
    throw new BotError({
      category: "validation",
      code: "UNKNOWN_MARKET",
      userMessage: `Market "${symbol}" not found.`,
      hint: "Use /markets to browse.",
      cause: e,
    });
  }

  if (!snapshot.markPrice || snapshot.markPrice <= 0) {
    throw new BotError({
      category: "api",
      code: "MARKET_CLOSED",
      userMessage: `No live price for ${symbol}.`,
      hint: "Market may be closed. Try again shortly.",
    });
  }

  const state = await getTraderState(user.walletAddress);
  const availableCollateral = Number(state.effectiveCollateral);

  const effectiveLeverage = Math.min(leverage, snapshot.maxLeverage);
  const notional = marginUsdc * effectiveLeverage;
  const feeUsdc = notional * snapshot.takerFee + (notional * config.BUILDER_FEE_BPS) / 10_000;
  const totalCost = marginUsdc + feeUsdc;

  if (totalCost > availableCollateral) {
    throw new BotError({
      category: "validation",
      code: "INSUFFICIENT_MARGIN",
      userMessage: `Need $${totalCost.toFixed(2)} USDC, you have $${availableCollateral.toFixed(2)}.`,
      hint: "Deposit more with /deposit or reduce your size.",
      meta: { totalCost, availableCollateral },
    });
  }

  if (snapshot.leverageTiers.length > 0) {
    const sorted = [...snapshot.leverageTiers].sort(
      (a, b) => a.maxNotionalUsdc - b.maxNotionalUsdc,
    );
    const tier = sorted.find((t) => notional <= t.maxNotionalUsdc);
    if (!tier) {
      const cap = sorted[sorted.length - 1].maxNotionalUsdc;
      throw new BotError({
        category: "validation",
        code: "TIER_OVERFLOW",
        userMessage: `Position too large for ${symbol}.`,
        hint: `Max notional is $${cap.toFixed(0)} USDC.`,
        meta: { notional, cap },
      });
    }
    if (effectiveLeverage > tier.maxLeverage) {
      throw new BotError({
        category: "validation",
        code: "TIER_OVERFLOW",
        userMessage: `At $${notional.toFixed(0)} USDC notional, max leverage is ${tier.maxLeverage}x.`,
        hint: "Reduce size or lower leverage.",
        meta: { effectiveLeverage, allowed: tier.maxLeverage },
      });
    }
  }

  if (anchorPrice && anchorPrice > 0) {
    const settings = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, user.id),
    });
    const slippageBps = settings?.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const drift = Math.abs(snapshot.markPrice - anchorPrice) / anchorPrice;
    const tolerance = slippageBps / 10_000;
    if (drift > tolerance) {
      throw new BotError({
        category: "validation",
        code: "PRICE_DRIFT",
        userMessage: `Price moved ${(drift * 100).toFixed(2)}% since you opened this quote.`,
        hint: "Re-open the trade to see the new price.",
        retryable: true,
        meta: { anchorPrice, currentPrice: snapshot.markPrice, slippageBps },
      });
    }
  }

  const mmFrac = 0.5 / snapshot.maxLeverage;
  const liqPrice =
    side === "long"
      ? snapshot.markPrice * (1 - 1 / effectiveLeverage + mmFrac)
      : snapshot.markPrice * (1 + 1 / effectiveLeverage - mmFrac);

  return {
    snapshot,
    effectiveLeverage,
    notional,
    feeUsdc,
    availableCollateral,
    liqPrice,
    totalCost,
  };
}
