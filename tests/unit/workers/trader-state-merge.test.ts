import type {
  TraderStatePositionSnapshot,
  TraderStateSubaccountDelta,
  TraderStateSubaccountSnapshot,
  TraderStateTradeHistoryDelta,
  TraderStateUpdate,
} from "@ellipsis-labs/rise";
import { describe, expect, it } from "vitest";
import {
  buildCachedPosition,
  fillNotional,
  fillSide,
  isLiquidation,
  mergeTraderState,
} from "../../../src/workers/trader-state-merge.js";

const decimals = async () => 2;

function position(
  symbol: string,
  lots: number,
  entryUsd: number,
): TraderStatePositionSnapshot {
  return {
    symbol,
    positionSequenceNumber: "1",
    basePositionLots: String(lots),
    entryPriceTicks: "0",
    entryPriceUsd: String(entryUsd),
    virtualQuotePositionLots: "0",
    unsettledFundingQuoteLots: "0",
    accumulatedFundingQuoteLots: "0",
    takeProfitTriggers: [],
    stopLossTriggers: [],
    conditionalTakeProfitTriggers: [],
    conditionalStopLossTriggers: [],
  };
}

function subSnapshot(
  subaccountIndex: number,
  sequence: number,
  collateral: number,
  positions: TraderStatePositionSnapshot[],
): TraderStateSubaccountSnapshot {
  return {
    subaccountIndex,
    sequence,
    collateral: String(collateral),
    positions,
    orders: [],
    splines: [],
    triggers: [],
  };
}

function snapshotUpdate(subaccounts: TraderStateSubaccountSnapshot[]): TraderStateUpdate {
  return {
    authority: "WALLET",
    traderPdaIndex: 0,
    slot: 1n,
    messageType: "snapshot",
    subaccounts,
    deltas: [],
  };
}

function subDelta(
  subaccountIndex: number,
  sequence: number,
  collateral: number,
  positions: TraderStateSubaccountDelta["positions"],
  tradeHistory: TraderStateTradeHistoryDelta[] = [],
): TraderStateSubaccountDelta {
  return {
    subaccountIndex,
    sequence,
    collateral: String(collateral),
    positions,
    orders: [],
    splines: [],
    triggers: [],
    tradeHistory,
    orderHistory: [],
  };
}

function deltaUpdate(deltas: TraderStateSubaccountDelta[]): TraderStateUpdate {
  return {
    authority: "WALLET",
    traderPdaIndex: 0,
    slot: 2n,
    messageType: "delta",
    subaccounts: [],
    deltas,
  };
}

function fill(overrides: Partial<TraderStateTradeHistoryDelta> = {}): TraderStateTradeHistoryDelta {
  return {
    timestamp: 0,
    slot: 0,
    slotIndex: 0,
    instructionIndex: 0,
    eventIndex: 0,
    market: "SOL",
    instructionType: "PlaceOrder",
    tradeType: "market",
    baseQtyBefore: "0",
    baseQtyAfter: "2",
    size: "2",
    liquidity: "taker",
    price: "100",
    fee: "0",
    realizedPnl: "0",
    signature: "sig",
    ...overrides,
  };
}

describe("mergeTraderState — snapshot", () => {
  it("builds positions and collateral from a snapshot", async () => {
    const update = snapshotUpdate([subSnapshot(0, 5, 17_468_604, [position("SOL", 205, 83.51)])]);
    const snap = await mergeTraderState(null, update, decimals);

    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0].symbol).toBe("SOL");
    expect(snap.positions[0].side).toBe("long");
    expect(snap.positions[0].sizeTokens).toBeCloseTo(2.05, 6);
    expect(snap.positions[0].entryPrice).toBe(83.51);
    expect(snap.depositedCollateralUsdc).toBeCloseTo(17.468604, 6);
    expect(snap.sequenceBySub[0]).toBe(5);
  });

  it("marks negative lots as short", async () => {
    const update = snapshotUpdate([subSnapshot(0, 1, 1_000_000, [position("ETH", -100, 2000)])]);
    const snap = await mergeTraderState(null, update, decimals);
    expect(snap.positions[0].side).toBe("short");
    expect(snap.positions[0].sizeTokens).toBeCloseTo(1, 6);
  });

  it("snapshot fully replaces previous state", async () => {
    const first = await mergeTraderState(
      null,
      snapshotUpdate([subSnapshot(0, 1, 1_000_000, [position("SOL", 100, 80)])]),
      decimals,
    );
    const second = await mergeTraderState(
      first,
      snapshotUpdate([subSnapshot(0, 2, 1_000_000, [position("BTC", 50, 70000)])]),
      decimals,
    );
    expect(second.positions.map((p) => p.symbol)).toEqual(["BTC"]);
  });
});

describe("mergeTraderState — delta", () => {
  it("upserts an updated position without duplicating", async () => {
    const prev = await mergeTraderState(
      null,
      snapshotUpdate([subSnapshot(0, 1, 1_000_000, [position("SOL", 100, 80)])]),
      decimals,
    );
    const next = await mergeTraderState(
      prev,
      deltaUpdate([subDelta(0, 2, 1_000_000, [{ symbol: "SOL", change: "updated", position: position("SOL", 300, 81) }])]),
      decimals,
    );
    expect(next.positions).toHaveLength(1);
    expect(next.positions[0].sizeTokens).toBeCloseTo(3, 6);
    expect(next.positions[0].entryPrice).toBe(81);
    expect(next.sequenceBySub[0]).toBe(2);
  });

  it("removes a closed position", async () => {
    const prev = await mergeTraderState(
      null,
      snapshotUpdate([subSnapshot(0, 1, 1_000_000, [position("SOL", 100, 80)])]),
      decimals,
    );
    const next = await mergeTraderState(
      prev,
      deltaUpdate([subDelta(0, 2, 1_000_000, [{ symbol: "SOL", change: "closed" }])]),
      decimals,
    );
    expect(next.positions).toHaveLength(0);
  });

  it("does not touch other subaccounts", async () => {
    const prev = await mergeTraderState(
      null,
      snapshotUpdate([
        subSnapshot(0, 1, 1_000_000, [position("SOL", 100, 80)]),
        subSnapshot(1, 1, 500_000, [position("GOLD", 10, 4500)]),
      ]),
      decimals,
    );
    const next = await mergeTraderState(
      prev,
      deltaUpdate([subDelta(0, 2, 1_000_000, [{ symbol: "SOL", change: "closed" }])]),
      decimals,
    );
    expect(next.positions.map((p) => p.symbol)).toEqual(["GOLD"]);
    expect(next.collateralBySub[1]).toBeCloseTo(0.5, 6);
  });

  it("replaces collateral for the changed subaccount", async () => {
    const prev = await mergeTraderState(
      null,
      snapshotUpdate([subSnapshot(0, 1, 1_000_000, [position("SOL", 100, 80)])]),
      decimals,
    );
    const next = await mergeTraderState(
      prev,
      deltaUpdate([subDelta(0, 2, 2_500_000, [])]),
      decimals,
    );
    expect(next.depositedCollateralUsdc).toBeCloseTo(2.5, 6);
  });

  it("drops a position when the market cannot be resolved", async () => {
    const prev = await mergeTraderState(
      null,
      snapshotUpdate([subSnapshot(0, 1, 1_000_000, [])]),
      decimals,
    );
    const next = await mergeTraderState(
      prev,
      deltaUpdate([subDelta(0, 2, 1_000_000, [{ symbol: "FOO", change: "updated", position: position("FOO", 100, 1) }])]),
      async () => null,
    );
    expect(next.positions).toHaveLength(0);
  });
});

describe("buildCachedPosition", () => {
  it("returns null for zero lots", () => {
    expect(buildCachedPosition("SOL", position("SOL", 0, 80), 0, 2)).toBeNull();
  });

  it("flags TP/SL presence", () => {
    const row = position("SOL", 100, 80);
    row.conditionalStopLossTriggers = [
      {
        conditionalStopLossId: "csl-0-1-lt",
        trigger: {
          triggerPriceTicks: "8000",
          executionPriceTicks: "7200",
          side: "ask",
          kind: "ioc",
          maxSizeLots: "100",
          fillableSizeLots: "100",
          filledSizeLots: "0",
          usePercent: false,
          percent: 0,
        },
        status: "active",
      },
    ];
    const cached = buildCachedPosition("SOL", row, 0, 2);
    expect(cached?.hasSl).toBe(true);
    expect(cached?.hasTp).toBe(false);
  });
});

describe("real captured payload (2026-05, SOL 25% partial close)", () => {
  it("applies the live snapshot then delta to the expected end-state", async () => {
    const snap = await mergeTraderState(
      null,
      snapshotUpdate([subSnapshot(0, 0, 17_468_604, [position("SOL", 205, 83.51)])]),
      decimals,
    );
    expect(snap.positions[0].sizeTokens).toBeCloseTo(2.05, 6);

    const afterClose = await mergeTraderState(
      snap,
      deltaUpdate([
        subDelta(
          0,
          1,
          16_983_047,
          [{ symbol: "SOL", change: "updated", position: position("SOL", 153, 83.51) }],
          [
            fill({
              market: "SOL",
              tradeType: "market",
              baseQtyBefore: "2.05",
              baseQtyAfter: "1.53",
              size: "0.52",
              price: "82.76",
              realizedPnl: "-0.39",
              liquidity: "taker",
            }),
          ],
        ),
      ]),
      decimals,
    );

    expect(afterClose.positions).toHaveLength(1);
    expect(afterClose.positions[0].sizeTokens).toBeCloseTo(1.53, 6);
    expect(afterClose.depositedCollateralUsdc).toBeCloseTo(16.983047, 6);
    expect(afterClose.sequenceBySub[0]).toBe(1);
  });

  it("classifies the captured partial-close fill as a sell", () => {
    const f = fill({ baseQtyBefore: "2.05", baseQtyAfter: "1.53", size: "0.52", price: "82.76" });
    expect(fillSide(f)).toBe("short");
    expect(fillNotional(f)).toBeCloseTo(43.0352, 4);
    expect(isLiquidation(f)).toBe(false);
  });
});

describe("fill helpers", () => {
  it("fillSide is long when position grew", () => {
    expect(fillSide(fill({ baseQtyBefore: "0", baseQtyAfter: "2" }))).toBe("long");
  });

  it("fillSide is short when position shrank", () => {
    expect(fillSide(fill({ baseQtyBefore: "5", baseQtyAfter: "3" }))).toBe("short");
  });

  it("fillNotional multiplies absolute size by price", () => {
    expect(fillNotional(fill({ size: "-2", price: "150" }))).toBe(300);
  });

  it("isLiquidation matches only liquidation trades", () => {
    expect(isLiquidation(fill({ tradeType: "liquidation" }))).toBe(true);
    expect(isLiquidation(fill({ tradeType: "market" }))).toBe(false);
  });
});
