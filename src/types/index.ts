import type { Context } from "grammy";
import type { User } from "../db/schema/users.js";

export interface ActionLogHint {
  skip?: boolean;
  outcome?: "success" | "error";
  errorCode?: string;
  errorCategory?: string;
  txSignature?: string;
}

export interface BotContext extends Context {
  user?: User;
  actionLog?: ActionLogHint;
}

// Phoenix risk tiers from traderState WebSocket
export type RiskTier =
  | "safe"
  | "healthy"
  | "atRisk"
  | "at_risk"
  | "cancellable"
  | "liquidatable"
  | "backstopLiquidatable"
  | "highRisk";

export interface TraderStateEvent {
  walletAddress: string;
  riskTier: RiskTier;
  riskScore: number;
  effectiveCollateral: string;
  depositedCollateral: string;
  unrealizedPnl: string;
  unsettledFunding: string;
  positions: PhoenixPosition[];
  fills?: PhoenixFill[];
}

export interface PhoenixPositionRung {
  leg: "tp" | "sl";
  triggerPrice: number;
  executionPrice: number;
  conditionalOrderIndex: number;
  maxSizeLots: string;
  filledSizeLots: string;
  mode: "limit" | "market";
}

export interface PhoenixPosition {
  symbol: string;
  side: "long" | "short";
  size: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  liquidationPrice: string;
  marginMode: "cross" | "isolated";
  subaccountIndex: number;
  leverage?: number;
  tpRungs?: PhoenixPositionRung[];
  slRungs?: PhoenixPositionRung[];
  positionLots?: string;
  baseLotsDecimals?: number;
}

export interface PhoenixFill {
  symbol: string;
  side: "long" | "short";
  size: string;
  price: string;
  fee: string;
  timestamp: number;
}

export interface CachedPosition {
  symbol: string;
  side: "long" | "short";
  sizeTokens: number;
  basePositionLots: number;
  entryPrice: number;
  subaccountIndex: number;
  unsettledFundingUsdc: number;
  hasTp: boolean;
  hasSl: boolean;
}

export interface AccountSnapshot {
  walletAddress: string;
  collateralBySub: Record<number, number>;
  depositedCollateralUsdc: number;
  positions: CachedPosition[];
  sequenceBySub: Record<number, number>;
  updatedAt: number;
}

export interface RestDerived {
  riskTier: RiskTier;
  effectiveCollateralUsdc: number;
  liqPriceBySymbol: Record<string, number>;
  marginBySymbol: Record<string, number>;
  updatedAt: number;
}

export interface DerivedPosition extends CachedPosition {
  mark: number;
  uPnl: number;
  notional: number;
}

export interface DerivedMetrics {
  positions: DerivedPosition[];
  totalExposure: number;
}
