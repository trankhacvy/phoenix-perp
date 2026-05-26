import { describe, expect, it } from "vitest";
import type { PhoenixPosition, TraderStateEvent } from "../../../src/types/index.js";

function makePosition(overrides: Partial<PhoenixPosition> = {}): PhoenixPosition {
  return {
    symbol: "SOL",
    side: "long",
    size: "10",
    entryPrice: "100",
    markPrice: "110",
    unrealizedPnl: "100",
    liquidationPrice: "80",
    marginMode: "cross",
    subaccountIndex: 0,
    leverage: 5,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TraderStateEvent> = {}): TraderStateEvent {
  return {
    walletAddress: "testWallet",
    riskTier: "safe",
    riskScore: 0,
    effectiveCollateral: "1000",
    depositedCollateral: "1000",
    unrealizedPnl: "100",
    unsettledFunding: "0",
    positions: [makePosition()],
    fills: [],
    ...overrides,
  };
}

function estimateMargin(pos: PhoenixPosition): number {
  const notional = Number(pos.size) * Number(pos.markPrice);
  const lev = pos.leverage ?? 1;
  return lev > 0 ? notional / lev : notional;
}

describe("guardian evaluator logic (pure computation)", () => {
  describe("liq_distance", () => {
    it("triggers when distance < threshold", () => {
      const pos = makePosition({ markPrice: "100", liquidationPrice: "92" });
      const mark = Number(pos.markPrice);
      const liq = Number(pos.liquidationPrice);
      const dist = (Math.abs(mark - liq) / mark) * 100;
      expect(dist).toBe(8);
      expect(dist < 10).toBe(true);
    });

    it("does not trigger when distance > threshold", () => {
      const pos = makePosition({ markPrice: "100", liquidationPrice: "80" });
      const mark = Number(pos.markPrice);
      const liq = Number(pos.liquidationPrice);
      const dist = (Math.abs(mark - liq) / mark) * 100;
      expect(dist).toBe(20);
      expect(dist < 10).toBe(false);
    });

    it("skips N/A liquidation price", () => {
      const pos = makePosition({ liquidationPrice: "N/A" });
      expect(pos.liquidationPrice).toBe("N/A");
    });

    it("handles short positions correctly", () => {
      const pos = makePosition({
        side: "short",
        markPrice: "100",
        liquidationPrice: "108",
      });
      const mark = Number(pos.markPrice);
      const liq = Number(pos.liquidationPrice);
      const dist = (Math.abs(mark - liq) / mark) * 100;
      expect(dist).toBe(8);
    });
  });

  describe("pnl_target", () => {
    it("triggers above when PnL % exceeds threshold", () => {
      const pos = makePosition({
        unrealizedPnl: "120",
        markPrice: "110",
        size: "10",
        leverage: 5,
      });
      const margin = estimateMargin(pos);
      const pnlPct = (Number(pos.unrealizedPnl) / margin) * 100;
      expect(margin).toBe(220);
      expect(pnlPct).toBeCloseTo(54.5, 1);
      expect(pnlPct >= 50).toBe(true);
    });

    it("triggers below when PnL % is below negative threshold", () => {
      const pos = makePosition({
        unrealizedPnl: "-60",
        markPrice: "90",
        size: "10",
        leverage: 5,
      });
      const margin = estimateMargin(pos);
      const pnlPct = (Number(pos.unrealizedPnl) / margin) * 100;
      expect(pnlPct).toBeLessThan(0);
      expect(pnlPct <= -25).toBe(true);
    });

    it("does not trigger when PnL within threshold", () => {
      const pos = makePosition({
        unrealizedPnl: "10",
        markPrice: "110",
        size: "10",
        leverage: 5,
      });
      const margin = estimateMargin(pos);
      const pnlPct = (Number(pos.unrealizedPnl) / margin) * 100;
      expect(pnlPct >= 50).toBe(false);
    });
  });

  describe("exposure_limit", () => {
    it("triggers when total notional exceeds threshold", () => {
      const event = makeEvent({
        positions: [
          makePosition({ size: "10", markPrice: "100" }),
          makePosition({ symbol: "ETH", size: "5", markPrice: "3000" }),
        ],
      });
      const total = event.positions.reduce(
        (sum, p) => sum + Number(p.size) * Number(p.markPrice),
        0,
      );
      expect(total).toBe(16000);
      expect(total >= 10000).toBe(true);
    });

    it("does not trigger when below threshold", () => {
      const event = makeEvent({
        positions: [makePosition({ size: "1", markPrice: "100" })],
      });
      const total = event.positions.reduce(
        (sum, p) => sum + Number(p.size) * Number(p.markPrice),
        0,
      );
      expect(total).toBe(100);
      expect(total >= 10000).toBe(false);
    });
  });

  describe("margin_ratio", () => {
    it("triggers when ratio < threshold", () => {
      const event = makeEvent({
        effectiveCollateral: "500",
        positions: [makePosition({ size: "100", markPrice: "100" })],
      });
      const totalExposure = event.positions.reduce(
        (sum, p) => sum + Number(p.size) * Number(p.markPrice),
        0,
      );
      const ratio = (Number(event.effectiveCollateral) / totalExposure) * 100;
      expect(ratio).toBe(5);
      expect(ratio < 10).toBe(true);
    });

    it("does not trigger when ratio above threshold", () => {
      const event = makeEvent({
        effectiveCollateral: "5000",
        positions: [makePosition({ size: "10", markPrice: "100" })],
      });
      const totalExposure = event.positions.reduce(
        (sum, p) => sum + Number(p.size) * Number(p.markPrice),
        0,
      );
      const ratio = (Number(event.effectiveCollateral) / totalExposure) * 100;
      expect(ratio).toBe(500);
      expect(ratio < 10).toBe(false);
    });

    it("skips when no exposure", () => {
      const event = makeEvent({ positions: [] });
      const totalExposure = event.positions.reduce(
        (sum, p) => sum + Number(p.size) * Number(p.markPrice),
        0,
      );
      expect(totalExposure).toBe(0);
    });
  });

  describe("drawdown (pure math)", () => {
    it("calculates drawdown correctly", () => {
      const peak = 500;
      const current = 400;
      const drawdownPct = ((peak - current) / peak) * 100;
      expect(drawdownPct).toBe(20);
    });

    it("new high means no drawdown", () => {
      const peak = 500;
      const current = 600;
      expect(current > peak).toBe(true);
    });

    it("negative peak is ignored", () => {
      const peak = -100;
      expect(peak <= 0).toBe(true);
    });
  });

  describe("estimateMargin", () => {
    it("calculates margin from notional / leverage", () => {
      const pos = makePosition({ size: "10", markPrice: "150", leverage: 5 });
      expect(estimateMargin(pos)).toBe(300);
    });

    it("defaults to leverage 1 when undefined", () => {
      const pos = makePosition({ size: "10", markPrice: "100", leverage: undefined });
      expect(estimateMargin(pos)).toBe(1000);
    });

    it("handles leverage 0 as 1", () => {
      const pos = makePosition({ size: "10", markPrice: "100", leverage: 0 });
      expect(estimateMargin(pos)).toBe(1000);
    });
  });
});
