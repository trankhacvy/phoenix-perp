import { describe, expect, it } from "vitest";
import { isIsolatedOnly } from "../../../src/services/phoenix/market.js";

describe("isIsolatedOnly", () => {
  it("returns true for GOLD, SILVER, SKR, WTIOIL", () => {
    expect(isIsolatedOnly("GOLD")).toBe(true);
    expect(isIsolatedOnly("SILVER")).toBe(true);
    expect(isIsolatedOnly("SKR")).toBe(true);
    expect(isIsolatedOnly("WTIOIL")).toBe(true);
  });

  it("returns false for regular markets", () => {
    expect(isIsolatedOnly("SOL")).toBe(false);
    expect(isIsolatedOnly("BTC")).toBe(false);
    expect(isIsolatedOnly("ETH")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isIsolatedOnly("gold")).toBe(true);
    expect(isIsolatedOnly("Gold")).toBe(true);
    expect(isIsolatedOnly("silver")).toBe(true);
  });
});
