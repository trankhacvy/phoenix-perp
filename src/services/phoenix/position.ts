import type { Position, TraderStateResponse, TraderView } from "@ellipsis-labs/rise";
import { withRetry } from "../../lib/retry.js";
import type { TraderStateEvent } from "../../types/index.js";
import { getPhoenixClient } from "./client.js";

export async function getTraderState(walletAddress: string): Promise<TraderStateEvent> {
  return withRetry(() => _getTraderState(walletAddress));
}

async function _getTraderState(walletAddress: string): Promise<TraderStateEvent> {
  const res = (await getPhoenixClient()
    .api.traders()
    .getTraderState(walletAddress)) as TraderStateResponse;

  const traders: TraderView[] = res.traders ?? [];

  // subaccount_index=0 is the cross account — primary collateral pool
  const crossAccount = traders.find((t) => t.traderSubaccountIndex === 0) ?? traders[0];

  if (!crossAccount) {
    return {
      walletAddress,
      riskTier: "safe",
      riskScore: 0,
      effectiveCollateral: "0",
      depositedCollateral: "0",
      unrealizedPnl: "0",
      unsettledFunding: "0",
      positions: [],
      fills: [],
    };
  }

  // Aggregate positions from every subaccount (cross + isolated)
  const positions: TraderStateEvent["positions"] = traders.flatMap((trader) =>
    (trader.positions ?? []).map((p: Position) => {
      const vq = p.virtualQuotePosition.value;
      const size = p.positionSize.ui;
      const posValue = Number(p.positionValue.ui);
      const posSize = Number(size) || 1;
      const markPriceComputed = String(posValue / posSize);
      const liqPriceRaw = Number(p.liquidationPrice.ui);
      const liqPrice = liqPriceRaw > 0 ? String(liqPriceRaw) : "N/A";
      const marginApprox = Number(p.initialMargin.ui);
      const leverageApprox = marginApprox > 0 ? Math.round(posValue / marginApprox) : undefined;
      const tpRaw = p.takeProfitPrice?.ui;
      const slRaw = p.stopLossPrice?.ui;
      return {
        symbol: String(p.symbol),
        side: vq <= 0 ? "long" : "short",
        size,
        entryPrice: p.entryPrice.ui,
        markPrice: markPriceComputed,
        unrealizedPnl: p.unrealizedPnl.ui,
        liquidationPrice: liqPrice,
        marginMode: trader.traderSubaccountIndex === 0 ? ("cross" as const) : ("isolated" as const),
        subaccountIndex: trader.traderSubaccountIndex,
        leverage: leverageApprox,
        takeProfit: tpRaw && Number(tpRaw) > 0 ? String(tpRaw) : undefined,
        stopLoss: slRaw && Number(slRaw) > 0 ? String(slRaw) : undefined,
      };
    }),
  );

  // Sum unrealizedPnl and unsettledFunding across all subaccounts
  const totalUnrealizedPnl = traders
    .reduce((sum, t) => sum + Number(t.unrealizedPnl.ui), 0)
    .toFixed(6);
  const totalUnsettledFunding = traders
    .reduce((sum, t) => sum + Number(t.unsettledFundingOwed.ui), 0)
    .toFixed(6);

  return {
    walletAddress,
    riskTier: crossAccount.riskTier ?? "safe",
    riskScore: 0,
    effectiveCollateral: crossAccount.effectiveCollateral.ui,
    depositedCollateral: crossAccount.collateralBalance.ui,
    unrealizedPnl: totalUnrealizedPnl,
    unsettledFunding: totalUnsettledFunding,
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
  fee?: string;
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
    // biome-ignore lint/suspicious/noExplicitAny: fee field not in SDK types yet
    fee: (r as any).fee ?? undefined,
    timestamp: r.timestamp,
    signature: r.signature ?? "",
    instructionType: r.instructionType,
  }));

  return {
    trades,
    hasMore: res.hasMore,
    nextCursor: res.nextCursor ?? undefined,
  };
}
