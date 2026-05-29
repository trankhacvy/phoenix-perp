import { logger } from "../lib/logger.js";
import { TokenBucket } from "../lib/rate-limiter.js";
import { getTraderState } from "../services/phoenix/position.js";
import type { RestDerived } from "../types/index.js";
import { getActiveWallets } from "./ws.js";

const log = logger.child({ worker: "rest-refresh" });

const SWEEP_INTERVAL_MS = 20_000;
const bucket = new TokenBucket(2, 0.5);

const restCache = new Map<string, RestDerived>();
const dirty = new Set<string>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;

export function getRestDerived(wallet: string): RestDerived | undefined {
  return restCache.get(wallet);
}

export function markRestDirty(wallet: string): void {
  dirty.add(wallet);
}

async function refreshWallet(wallet: string): Promise<void> {
  await bucket.acquire();
  const state = await getTraderState(wallet);
  const liqPriceBySymbol: Record<string, number> = {};
  const marginBySymbol: Record<string, number> = {};
  for (const p of state.positions) {
    liqPriceBySymbol[p.symbol] = p.liquidationPrice === "N/A" ? 0 : Number(p.liquidationPrice);
    const notional = Number(p.size) * Number(p.markPrice);
    const lev = p.leverage && p.leverage > 0 ? p.leverage : 1;
    marginBySymbol[p.symbol] = notional / lev;
  }
  restCache.set(wallet, {
    riskTier: state.riskTier,
    effectiveCollateralUsdc: Number(state.effectiveCollateral),
    liqPriceBySymbol,
    marginBySymbol,
    updatedAt: Date.now(),
  });
}

async function drain(wallets: string[]): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (const wallet of wallets) {
      try {
        await refreshWallet(wallet);
      } catch (err) {
        log.warn({ err, wallet }, "REST refresh failed");
      }
    }
  } finally {
    draining = false;
  }
}

async function tick(): Promise<void> {
  const queued = [...dirty];
  dirty.clear();
  const sweep = getActiveWallets().filter((w) => !queued.includes(w));
  await drain([...queued, ...sweep]);
}

export function startRestRefreshLoop(): void {
  stopRestRefreshLoop();
  sweepTimer = setInterval(() => {
    tick().catch((err) => log.error({ err }, "REST refresh tick failed"));
  }, SWEEP_INTERVAL_MS);
}

export function stopRestRefreshLoop(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
