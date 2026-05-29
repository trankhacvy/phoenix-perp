import { logger } from "../lib/logger.js";
import { getStats } from "../services/phoenix/market-stats-feed.js";
import { getMids, onMids } from "../services/phoenix/price-feed.js";
import type { AccountSnapshot, DerivedMetrics, DerivedPosition } from "../types/index.js";
import { evaluateGuardianRules } from "./evaluators/guardian.js";
import { evaluateRiskTier } from "./evaluators/risk-tier.js";
import { getRestDerived } from "./rest-refresh.js";
import { getOwnerUserId, getOwners, getSnapshot } from "./ws.js";

const EVAL_INTERVAL_MS = 1000;
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

export function deriveMetrics(
  snap: AccountSnapshot,
  mids: ReadonlyMap<string, number>,
): DerivedMetrics {
  const positions: DerivedPosition[] = snap.positions.map((p) => {
    const mark = getStats(p.symbol)?.markPrice ?? mids.get(p.symbol) ?? p.entryPrice;
    const uPnl =
      (p.side === "long" ? mark - p.entryPrice : p.entryPrice - mark) * p.sizeTokens +
      p.unsettledFundingUsdc;
    return { ...p, mark, uPnl, notional: p.sizeTokens * mark };
  });
  const totalExposure = positions.reduce((acc, p) => acc + p.notional, 0);
  return { positions, totalExposure };
}

async function runOnce(mids: ReadonlyMap<string, number>): Promise<void> {
  for (const { walletAddress, telegramId } of getOwners()) {
    try {
      const snap = getSnapshot(walletAddress);
      if (!snap || snap.positions.length === 0) continue;
      const userId = (await getOwnerUserId(walletAddress)) ?? telegramId;
      const derived = deriveMetrics(snap, mids);
      const rest = getRestDerived(walletAddress);
      await evaluateRiskTier(telegramId, userId, rest, snap.positions);
      await evaluateGuardianRules({
        userId,
        telegramId,
        walletAddress,
        snapshot: snap,
        derived,
        rest,
      });
    } catch (err) {
      logger.error({ err, walletAddress }, "eval owner failed");
    }
  }
}

function tick(): void {
  if (running) return;
  running = true;
  runOnce(getMids())
    .catch((err) => logger.error({ err }, "eval loop failed"))
    .finally(() => {
      running = false;
    });
}

export function startEvalLoop(): void {
  if (timer) return;
  timer = setInterval(tick, EVAL_INTERVAL_MS);
  unsubscribe = onMids(() => tick());
}

export function stopEvalLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
}
