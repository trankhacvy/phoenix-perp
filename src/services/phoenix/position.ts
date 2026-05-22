import type { TraderStateEvent } from "../../types/index.js";
import { getPhoenixClient } from "./client.js";

function uiStr(field: unknown): string {
  if (field && typeof field === "object" && "ui" in (field as object)) {
    return String((field as { ui: unknown }).ui);
  }
  return String(field ?? "0");
}

export async function getTraderState(walletAddress: string): Promise<TraderStateEvent> {
  const res = await getPhoenixClient().api.traders().getTraderState(walletAddress);
  const traders = (res as { traders?: unknown[] }).traders;
  const t = (Array.isArray(traders) ? traders[0] : res) as Record<string, unknown>;

  const rawPositions = Array.isArray(t.positions) ? (t.positions as Record<string, unknown>[]) : [];

  const positions: TraderStateEvent["positions"] = rawPositions.map((p) => {
    const vq = (p.virtualQuotePosition as { value?: number } | undefined)?.value ?? 0;
    const size = uiStr(p.positionSize);
    const posValue = Number(uiStr(p.positionValue));
    const posSize = Number(size) || 1;
    const markPriceComputed = (posValue / posSize).toFixed(4);
    const liqPriceRaw = Number(uiStr(p.liquidationPrice));
    const liqPrice = liqPriceRaw > 0 ? liqPriceRaw.toFixed(4) : "N/A";
    return {
      symbol: String(p.symbol ?? ""),
      side: vq <= 0 ? "long" : "short",
      size,
      entryPrice: uiStr(p.entryPrice),
      markPrice: markPriceComputed,
      unrealizedPnl: uiStr(p.unrealizedPnl),
      liquidationPrice: liqPrice,
      marginMode: "cross" as const,
      subaccountIndex: 0,
    };
  });

  return {
    walletAddress,
    riskTier: (t.riskTier as TraderStateEvent["riskTier"]) ?? "safe",
    riskScore: Number(t.riskScore ?? 0),
    effectiveCollateral: uiStr(t.effectiveCollateral),
    depositedCollateral: uiStr(t.collateralBalance),
    unrealizedPnl: uiStr(t.unrealizedPnl),
    unsettledFunding: uiStr(t.unsettledFundingOwed),
    positions,
    fills: [],
  };
}

export async function getTraderStateSnapshot(walletAddress: string) {
  return getPhoenixClient()
    .api.traders()
    .getTraderStateSnapshot(walletAddress, { traderPdaIndex: 0 });
}

export interface TradeHistoryEntry {
  symbol: string;
  side: "long" | "short";
  realizedPnl: string;
  price: string;
  size: string;
  timestamp: number;
  signature: string;
  instructionType: string;
}

export interface TradeHistoryResponse {
  trades: TradeHistoryEntry[];
  hasMore: boolean;
  nextCursor?: string;
}

export async function getTradeHistory(
  walletAddress: string,
  limit = 20,
): Promise<TradeHistoryResponse> {
  const res = await getPhoenixClient()
    .api.trades()
    .getTraderTradesHistory(walletAddress, { limit });

  const trades: TradeHistoryEntry[] = res.data.map((r) => ({
    symbol: r.marketSymbol,
    side: Number(r.baseLotsDelta) >= 0 ? "long" : "short",
    realizedPnl: r.realizedPnl,
    price: r.price,
    size: String(Math.abs(Number(r.baseLotsDelta))),
    timestamp: r.timestamp,
    signature: r.signature ?? "",
    instructionType: r.instructionType,
  }));

  return { trades, hasMore: res.hasMore, nextCursor: res.nextCursor ?? undefined };
}
