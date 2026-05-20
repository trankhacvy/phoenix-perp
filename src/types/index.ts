import type { Context } from "grammy";
import type { User } from "../db/schema/users.js";

export interface BotContext extends Context {
  user?: User;
}

// Phoenix risk tiers from traderState WebSocket
export type RiskTier =
  | "Safe"
  | "AtRisk"
  | "Cancellable"
  | "Liquidatable"
  | "BackstopLiquidatable"
  | "HighRisk";

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
}

export interface PhoenixFill {
  symbol: string;
  side: "long" | "short";
  size: string;
  price: string;
  fee: string;
  timestamp: number;
}
