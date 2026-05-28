import type { TraderStateTradeHistoryDelta } from "@ellipsis-labs/rise";
import { type AlertButton, alertQueue } from "../../jobs/queues.js";
import { isIsolatedOnly } from "../../services/phoenix/market.js";
import type { CachedPosition } from "../../types/index.js";
import { fillSide } from "../trader-state-merge.js";
import { esc } from "./shared.js";

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, "");
}

function copyCounterKb(
  symbol: string,
  side: "long" | "short",
  walletAddress: string,
): AlertButton[][] {
  const counter = side === "long" ? "short" : "long";
  const copyLabel = side === "long" ? "🟢 Copy Long" : "🔴 Copy Short";
  const counterLabel = counter === "long" ? "🟢 Counter Long" : "🔴 Counter Short";
  const rows: AlertButton[][] = [];
  if (!isIsolatedOnly(symbol)) {
    rows.push([
      { text: `${copyLabel} ${symbol}`, callback_data: `trade:${side}:${symbol}` },
      { text: `${counterLabel} ${symbol}`, callback_data: `trade:${counter}:${symbol}` },
    ]);
  }
  rows.push([{ text: "📊 Trader", callback_data: `walletinfo:back:${walletAddress}` }]);
  return rows;
}

function traderKb(walletAddress: string): AlertButton[][] {
  return [[{ text: "📊 Trader", callback_data: `walletinfo:back:${walletAddress}` }]];
}

export async function evaluateMonitorAlerts(
  walletAddress: string,
  watcherTelegramIds: string[],
  positions: CachedPosition[],
  prevPositions: CachedPosition[] | null,
) {
  if (!prevPositions) return;

  const shortEsc = esc(walletAddress);
  const alerts: { type: string; symbol: string; message: string; keyboard?: AlertButton[][] }[] =
    [];

  for (const pos of positions) {
    const existed = prevPositions.find((p) => p.symbol === pos.symbol);
    if (!existed) {
      alerts.push({
        type: "monitor_open",
        symbol: pos.symbol,
        message: `👁 <b>${shortEsc} opened ${esc(pos.symbol)}</b>\n${esc(pos.side.toUpperCase())} · ${esc(fmtNum(pos.sizeTokens))} ${esc(pos.symbol)} @ $${esc(fmtNum(pos.entryPrice))}`,
        keyboard: copyCounterKb(pos.symbol, pos.side, walletAddress),
      });
    } else if (existed.side !== pos.side) {
      alerts.push({
        type: "monitor_flip",
        symbol: pos.symbol,
        message: `👁 <b>${shortEsc} flipped ${esc(pos.symbol)}</b>\n${esc(existed.side.toUpperCase())} → ${esc(pos.side.toUpperCase())}`,
        keyboard: copyCounterKb(pos.symbol, pos.side, walletAddress),
      });
    }
  }

  for (const prevPos of prevPositions) {
    const still = positions.find((p) => p.symbol === prevPos.symbol);
    if (!still) {
      alerts.push({
        type: "monitor_close",
        symbol: prevPos.symbol,
        message: `👁 <b>${shortEsc} closed ${esc(prevPos.symbol)}</b>\nWas ${esc(prevPos.side.toUpperCase())} · ${esc(fmtNum(prevPos.sizeTokens))} ${esc(prevPos.symbol)}`,
        keyboard: traderKb(walletAddress),
      });
    }
  }

  for (const telegramId of watcherTelegramIds) {
    for (const alert of alerts) {
      await alertQueue.add("monitor-alert", {
        telegramId,
        type: alert.type,
        symbol: alert.symbol,
        message: alert.message,
        keyboard: alert.keyboard,
      });
    }
  }
}

export function emitMonitorFills(
  walletAddress: string,
  watcherTelegramIds: string[],
  fills: TraderStateTradeHistoryDelta[],
) {
  const shortEsc = esc(walletAddress);
  for (const telegramId of watcherTelegramIds) {
    for (const fill of fills) {
      const verb = fillSide(fill) === "long" ? "BUY" : "SELL";
      void alertQueue.add("monitor-fill", {
        telegramId,
        type: "monitor_fill",
        symbol: fill.market,
        message: `👁 <b>${shortEsc} filled ${esc(fill.market)}</b>\n${verb} · ${esc(fill.size)} @ $${esc(Number(fill.price).toFixed(4))} (${esc(fill.liquidity)})`,
        keyboard: [[{ text: "📊 Trader", callback_data: `walletinfo:back:${walletAddress}` }]],
      });
    }
  }
}
