import { describe, expect, it } from "vitest";
import { fromNative, toNative, tokensToLots } from "../../../src/lib/amount.js";

describe("toNative", () => {
  it("parses whole and fractional values", () => {
    expect(toNative("123.456789", 6)).toBe(123456789n);
    expect(toNative("1.5", 6)).toBe(1500000n);
    expect(toNative("50", 6)).toBe(50000000n);
    expect(toNative("0", 6)).toBe(0n);
  });

  it("keeps trailing-zero decimals exact", () => {
    expect(toNative("1.50", 6)).toBe(1500000n);
    expect(toNative(".5", 6)).toBe(500000n);
  });

  it("truncates (floors) excess fractional digits", () => {
    expect(toNative("1.2345678", 6)).toBe(1234567n);
  });

  it("stays exact beyond 2^53", () => {
    expect(toNative("9007199254740993.5", 6)).toBe(9007199254740993500000n);
  });

  it("rejects invalid input", () => {
    expect(() => toNative("", 6)).toThrow();
    expect(() => toNative(".", 6)).toThrow();
    expect(() => toNative("1.2.3", 6)).toThrow();
    expect(() => toNative("abc", 6)).toThrow();
  });
});

describe("fromNative", () => {
  it("round-trips toNative", () => {
    expect(fromNative(123456789n, 6)).toBe("123.456789");
    expect(fromNative(1500000n, 6)).toBe("1.5");
    expect(fromNative(50000000n, 6)).toBe("50");
    expect(fromNative(0n, 6)).toBe("0");
  });

  it("handles values smaller than one unit", () => {
    expect(fromNative(500000n, 6)).toBe("0.5");
    expect(fromNative(1n, 6)).toBe("0.000001");
  });
});

describe("tokensToLots", () => {
  it("uses the market decimals", () => {
    expect(tokensToLots("1.5", 5)).toBe(150000n);
    expect(tokensToLots("0.00000001", 8)).toBe(1n);
  });
});
