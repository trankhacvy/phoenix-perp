import { db } from "../db/index.js";
import { trades } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface TradeRecord {
  userId: string;
  walletAddress: string;
  symbol: string;
  side: "long" | "short";
  action: "open" | "close";
  marginUsdc?: number;
  leverage?: number;
  notionalUsdc: number;
  baseUnits: string;
  markPrice: number;
  feeUsdc?: number;
  closeFraction?: number;
  txSignature?: string;
}

export function recordTrade(record: TradeRecord): void {
  db.insert(trades)
    .values({
      id: makeId(),
      userId: record.userId,
      walletAddress: record.walletAddress,
      symbol: record.symbol,
      side: record.side,
      action: record.action,
      marginUsdc: record.marginUsdc?.toFixed(6),
      leverage: record.leverage?.toFixed(2),
      notionalUsdc: record.notionalUsdc.toFixed(6),
      baseUnits: record.baseUnits,
      markPrice: record.markPrice.toFixed(6),
      feeUsdc: record.feeUsdc?.toFixed(6),
      closeFraction: record.closeFraction?.toFixed(4),
      txSignature: record.txSignature,
    })
    .then(() => {
      logger.debug({ symbol: record.symbol, action: record.action }, "trade recorded");
    })
    .catch((err) => {
      logger.warn({ err, symbol: record.symbol, action: record.action }, "trade record failed");
    });
}
