import type {
  TraderStatePositionSnapshot,
  TraderStateTradeHistoryDelta,
  TraderStateUpdate,
} from "@ellipsis-labs/rise";
import type { AccountSnapshot, CachedPosition } from "../types/index.js";

export type PositionRowLike = Pick<
  TraderStatePositionSnapshot,
  | "basePositionLots"
  | "entryPriceUsd"
  | "unsettledFundingQuoteLots"
  | "conditionalTakeProfitTriggers"
  | "conditionalStopLossTriggers"
>;

export type DecimalsResolver = (symbol: string) => Promise<number | null>;

export function buildCachedPosition(
  symbol: string,
  row: PositionRowLike,
  subaccountIndex: number,
  baseLotsDecimals: number,
): CachedPosition | null {
  const lots = Number(row.basePositionLots);
  if (lots === 0) return null;
  return {
    symbol,
    side: lots > 0 ? "long" : "short",
    sizeTokens: Math.abs(lots) * 10 ** -baseLotsDecimals,
    basePositionLots: lots,
    entryPrice: Number(row.entryPriceUsd ?? "0"),
    subaccountIndex,
    unsettledFundingUsdc: Number(row.unsettledFundingQuoteLots) / 1e6,
    hasTp: (row.conditionalTakeProfitTriggers?.length ?? 0) > 0,
    hasSl: (row.conditionalStopLossTriggers?.length ?? 0) > 0,
  };
}

export function groupBySub(positions: CachedPosition[]): Map<number, CachedPosition[]> {
  const map = new Map<number, CachedPosition[]>();
  for (const p of positions) {
    const list = map.get(p.subaccountIndex) ?? [];
    list.push(p);
    map.set(p.subaccountIndex, list);
  }
  return map;
}

export async function mergeTraderState(
  prev: AccountSnapshot | null,
  update: TraderStateUpdate,
  resolveDecimals: DecimalsResolver,
): Promise<AccountSnapshot> {
  const collateralBySub: Record<number, number> = {};
  const sequenceBySub: Record<number, number> = {};
  let posBySub: Map<number, CachedPosition[]>;

  if (update.messageType === "snapshot") {
    posBySub = new Map();
    for (const sub of update.subaccounts) {
      collateralBySub[sub.subaccountIndex] = Number(sub.collateral) / 1e6;
      sequenceBySub[sub.subaccountIndex] = sub.sequence;
      const list: CachedPosition[] = [];
      for (const p of sub.positions) {
        const decimals = await resolveDecimals(p.symbol);
        if (decimals === null) continue;
        const cached = buildCachedPosition(p.symbol, p, sub.subaccountIndex, decimals);
        if (cached) list.push(cached);
      }
      posBySub.set(sub.subaccountIndex, list);
    }
  } else {
    Object.assign(collateralBySub, prev?.collateralBySub ?? {});
    Object.assign(sequenceBySub, prev?.sequenceBySub ?? {});
    posBySub = groupBySub(prev?.positions ?? []);
    for (const sub of update.deltas) {
      collateralBySub[sub.subaccountIndex] = Number(sub.collateral) / 1e6;
      sequenceBySub[sub.subaccountIndex] = sub.sequence;
      const list = posBySub.get(sub.subaccountIndex) ?? [];
      for (const pd of sub.positions) {
        const idx = list.findIndex((x) => x.symbol === pd.symbol);
        if (pd.change === "closed") {
          if (idx >= 0) list.splice(idx, 1);
          continue;
        }
        if (pd.position) {
          const decimals = await resolveDecimals(pd.symbol);
          if (decimals === null) continue;
          const cached = buildCachedPosition(pd.symbol, pd.position, sub.subaccountIndex, decimals);
          if (cached) {
            if (idx >= 0) list[idx] = cached;
            else list.push(cached);
          } else if (idx >= 0) {
            list.splice(idx, 1);
          }
        }
      }
      posBySub.set(sub.subaccountIndex, list);
    }
  }

  const positions = [...posBySub.values()].flat();
  const depositedCollateralUsdc = Object.values(collateralBySub).reduce((a, b) => a + b, 0);

  return {
    walletAddress: prev?.walletAddress ?? String(update.authority),
    collateralBySub,
    depositedCollateralUsdc,
    positions,
    sequenceBySub,
    updatedAt: Date.now(),
  };
}

export function fillSide(fill: TraderStateTradeHistoryDelta): "long" | "short" {
  return Number(fill.baseQtyAfter) >= Number(fill.baseQtyBefore) ? "long" : "short";
}

export function fillNotional(fill: TraderStateTradeHistoryDelta): number {
  return Math.abs(Number(fill.size)) * Number(fill.price);
}

export function isLiquidation(fill: TraderStateTradeHistoryDelta): boolean {
  return fill.tradeType === "liquidation";
}
