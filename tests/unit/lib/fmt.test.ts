import { describe, expect, it } from "vitest";
import {
  change24h,
  fundingAnnual,
  fundingDailyUsd,
  fundingDotAnnual,
  fundingHourly,
  liqDistanceLabel,
} from "../../../src/bot/lib/fmt.js";

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

describe("marketStats funding formatters (values are already percentages)", () => {
  it("fundingAnnual appends %/yr with sign, no scaling", () => {
    expect(fundingAnnual(21.41)).toBe("+21.41%/yr");
    expect(fundingAnnual(0)).toBe("+0.0%/yr");
    expect(fundingAnnual(-5)).toBe("-5.0%/yr");
  });

  it("fundingHourly keeps 4 decimals with sign, no scaling", () => {
    expect(fundingHourly(0.0024)).toBe("+0.0024%/h");
    expect(fundingHourly(-0.0012)).toBe("-0.0012%/h");
  });

  it("change24h shows arrow + absolute percent", () => {
    expect(change24h(1.51)).toBe("▲ 1.51%");
    expect(change24h(-2)).toBe("▼ 2.00%");
    expect(change24h(0)).toBe("▲ 0.00%");
  });

  it("fundingDotAnnual keys off annualized magnitude", () => {
    expect(fundingDotAnnual(21)).toBe("🟢");
    expect(fundingDotAnnual(-21)).toBe("🔴");
    expect(fundingDotAnnual(0.5)).toBe("⚪");
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
