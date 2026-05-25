import { describe, expect, it } from "vitest";
import { fundingDailyUsd, liqDistanceLabel } from "../../../src/bot/lib/fmt.js";

describe("fundingDailyUsd", () => {
  it("computes positive rate correctly (24 hourly periods/day)", () => {
    expect(fundingDailyUsd(0.0001, 10000)).toBe("$24.00/day");
  });

  it("uses absolute value for negative rates", () => {
    expect(fundingDailyUsd(-0.0002, 5000)).toBe("$24.00/day");
  });

  it("returns $0.00/day for zero rate", () => {
    expect(fundingDailyUsd(0, 10000)).toBe("$0.00/day");
  });

  it("formats small values with two decimals", () => {
    expect(fundingDailyUsd(0.00001, 1000)).toBe("$0.24/day");
  });
});

describe("liqDistanceLabel", () => {
  it("uses 'falls' direction for longs", () => {
    const result = liqDistanceLabel("long", 100, 90);
    expect(result).toContain("falls");
    expect(result).toContain("10");
    expect(result).toContain("90");
  });

  it("uses 'rises' direction for shorts", () => {
    const result = liqDistanceLabel("short", 100, 110);
    expect(result).toContain("rises");
    expect(result).toContain("10");
    expect(result).toContain("110");
  });

  it("computes correct percentage for long", () => {
    const result = liqDistanceLabel("long", 87000, 78300);
    expect(result).toContain("falls");
    expect(result).toContain("78,300");
  });

  it("computes correct percentage for short", () => {
    const result = liqDistanceLabel("short", 87000, 95700);
    expect(result).toContain("rises");
    expect(result).toContain("95,700");
  });
});
