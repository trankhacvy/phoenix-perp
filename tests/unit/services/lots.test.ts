import { describe, expect, it } from "vitest";
import { BotError } from "../../../src/bot/lib/errors.js";
import {
  baseLotsToTokens,
  fractionToCloseLots,
  marginToTokens,
} from "../../../src/services/phoenix/lots.js";

const SOL = { symbol: "SOL", markPrice: 100, baseLotsDecimals: 4 };
const BTC = { symbol: "BTC", markPrice: 50_000, baseLotsDecimals: 8 };

describe("marginToTokens", () => {
  it("converts $100 @ 10x SOL to 10.0000", () => {
    expect(marginToTokens(SOL, 100, 10)).toBe("10.0000");
  });

  it("rounds down to base lot precision for BTC (8 decimals)", () => {
    expect(marginToTokens(BTC, 100, 10)).toBe("0.02000000");
  });

  it("floors fractional lots so we never overshoot margin", () => {
    const ETH = { symbol: "ETH", markPrice: 3333, baseLotsDecimals: 4 };
    expect(marginToTokens(ETH, 100, 1)).toBe("0.0300");
  });

  it("throws SIZE_TOO_SMALL below minimum lot", () => {
    expect(() => marginToTokens(SOL, 0.0001, 1)).toThrow(BotError);
    try {
      marginToTokens(SOL, 0.0001, 1);
    } catch (e) {
      expect((e as BotError).code).toBe("SIZE_TOO_SMALL");
    }
  });

  it("throws INVALID_INPUT on zero or negative margin", () => {
    expect(() => marginToTokens(SOL, 0, 10)).toThrow(BotError);
    expect(() => marginToTokens(SOL, -1, 10)).toThrow(BotError);
  });

  it("throws LEV_OUT_OF_RANGE on bad leverage", () => {
    expect(() => marginToTokens(SOL, 100, 0)).toThrow(BotError);
    expect(() => marginToTokens(SOL, 100, 0.5)).toThrow(BotError);
  });

  it("throws UNKNOWN_MARKET when mark price is zero", () => {
    expect(() => marginToTokens({ ...SOL, markPrice: 0 }, 100, 10)).toThrow(BotError);
  });

  it("uses priceOverride instead of snapshot mark when provided", () => {
    expect(marginToTokens(SOL, 100, 10, 50)).toBe("20.0000");
  });

  it("falls back to snapshot mark when priceOverride is invalid", () => {
    expect(marginToTokens(SOL, 100, 10, 0)).toBe("10.0000");
    expect(marginToTokens(SOL, 100, 10, Number.NaN)).toBe("10.0000");
  });
});

describe("fractionToCloseLots", () => {
  it("halves a 1000-lot position", () => {
    expect(fractionToCloseLots(1000, 0.5)).toBe(500n);
  });

  it("works on negative positions (shorts)", () => {
    expect(fractionToCloseLots(-1000, 1)).toBe(1000n);
  });

  it("rejects fraction outside (0, 1]", () => {
    expect(() => fractionToCloseLots(1000, 0)).toThrow(BotError);
    expect(() => fractionToCloseLots(1000, 1.5)).toThrow(BotError);
    expect(() => fractionToCloseLots(1000, -0.1)).toThrow(BotError);
  });

  it("ceil rounds up small fractions so 1 lot * 0.01 = 1 lot", () => {
    expect(fractionToCloseLots(1, 0.01)).toBe(1n);
  });

  it("throws SIZE_TOO_SMALL when position is 0 lots", () => {
    expect(() => fractionToCloseLots(0, 1)).toThrow(BotError);
  });
});

describe("baseLotsToTokens", () => {
  it("inverts marginToTokens precision for SOL", () => {
    expect(baseLotsToTokens({ baseLotsDecimals: 4 }, 100_000)).toBeCloseTo(10);
  });
});
