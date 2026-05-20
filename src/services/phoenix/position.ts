import { config } from "../../config/index.js";
import type { TraderStateEvent } from "../../types/index.js";

export async function getTraderState(walletAddress: string): Promise<TraderStateEvent> {
  const res = await fetch(`${config.PHOENIX_API_URL}/traders/${walletAddress}/state`);
  if (!res.ok) throw new Error(`Failed to fetch trader state: ${res.status}`);
  return res.json() as Promise<TraderStateEvent>;
}

export interface TradeHistoryEntry {
  symbol: string;
  side: "long" | "short";
  realizedPnl: string;
  entryPrice: string;
  exitPrice: string;
  roiPercent: string;
  size: string;
  status: string;
  timestamp: number;
}

export interface TradeHistoryResponse {
  trades: TradeHistoryEntry[];
  total: number;
}

export async function getTradeHistory(
  walletAddress: string,
  limit = 20,
  offset = 0,
): Promise<TradeHistoryResponse> {
  const res = await fetch(
    `${config.PHOENIX_API_URL}/traders/${walletAddress}/history?limit=${limit}&offset=${offset}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch trade history: ${res.status}`);
  return res.json() as Promise<TradeHistoryResponse>;
}
