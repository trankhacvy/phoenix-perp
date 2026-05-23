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

async function _fetchPage(
  walletAddress: string,
  limit: number,
  cursor?: string,
): Promise<TradeHistoryResponse> {
  // biome-ignore lint/suspicious/noExplicitAny: cursor param not in SDK type definitions
  const opts: any = cursor ? { limit, cursor } : { limit };
  const res = await getPhoenixClient().api.trades().getTraderTradesHistory(walletAddress, opts);
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

export async function getTradeHistory(
  walletAddress: string,
  limit = 20,
): Promise<TradeHistoryResponse> {
  return _fetchPage(walletAddress, limit);
}

export async function fetchAllTradeHistory(
  walletAddress: string,
  maxFills = 500,
): Promise<TradeHistoryEntry[]> {
  const all: TradeHistoryEntry[] = [];
  let cursor: string | undefined;
  while (all.length < maxFills) {
    const page = await _fetchPage(walletAddress, 100, cursor);
    all.push(...page.trades);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

export interface MarketPnl {
  symbol: string;
  fills: number;
  realizedPnl: number;
  wins: number;
  closes: number;
  volume: number;
}

export interface WalletAnalytics {
  totalFills: number;
  marketsCount: number;
  totalVolume: number;
  realizedPnl: number;
  closedTrades: number;
  wins: number;
  lastFillAt: number | null;
  longCount: number;
  shortCount: number;
  makerCount: number;
  bestTrade: { pnl: number; action: string; symbol: string } | null;
  worstTrade: { pnl: number; action: string; symbol: string } | null;
  perMarket: MarketPnl[];
}

export function computeWalletAnalytics(trades: TradeHistoryEntry[]): WalletAnalytics {
  let totalVolume = 0;
  let realizedPnl = 0;
  let closedTrades = 0;
  let wins = 0;
  let longCount = 0;
  let makerCount = 0;
  let lastFillAt: number | null = null;
  let bestTrade: WalletAnalytics["bestTrade"] = null;
  let worstTrade: WalletAnalytics["worstTrade"] = null;
  const marketMap = new Map<string, MarketPnl>();

  for (const t of trades) {
    const price = Number(t.price);
    const size = Number(t.size);
    const pnl = Number(t.realizedPnl);
    const volume = price * size;
    const isClose = Number(t.realizedPnl) !== 0;
    const isMaker = t.instructionType === "UncrossCrank";

    totalVolume += volume;
    if (t.side === "long") longCount++;
    if (isMaker) makerCount++;
    if (lastFillAt === null || t.timestamp > lastFillAt) lastFillAt = t.timestamp;

    if (isClose) {
      realizedPnl += pnl;
      closedTrades++;
      if (pnl > 0) wins++;
      // close direction is inverted: short fill = closing a long position
      const action = t.side === "short" ? "LONG" : "SHORT";
      if (bestTrade === null || pnl > bestTrade.pnl) bestTrade = { pnl, action, symbol: t.symbol };
      if (worstTrade === null || pnl < worstTrade.pnl)
        worstTrade = { pnl, action, symbol: t.symbol };
    }

    let mkt = marketMap.get(t.symbol);
    if (!mkt) {
      mkt = {
        symbol: t.symbol,
        fills: 0,
        realizedPnl: 0,
        wins: 0,
        closes: 0,
        volume: 0,
      };
      marketMap.set(t.symbol, mkt);
    }
    mkt.fills++;
    mkt.volume += volume;
    if (isClose) {
      mkt.realizedPnl += pnl;
      mkt.closes++;
      if (pnl > 0) mkt.wins++;
    }
  }

  const perMarket = Array.from(marketMap.values()).sort(
    (a, b) => Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl),
  );

  return {
    totalFills: trades.length,
    marketsCount: marketMap.size,
    totalVolume,
    realizedPnl,
    closedTrades,
    wins,
    lastFillAt,
    longCount,
    shortCount: trades.length - longCount,
    makerCount,
    bestTrade,
    worstTrade,
    perMarket,
  };
}
