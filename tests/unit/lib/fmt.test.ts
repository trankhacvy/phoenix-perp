import { describe, expect, it } from "vitest";
import {
  change24h,
  compact,
  compactSigned,
  fundingAnnual,
  fundingDailyUsd,
  fundingDotAnnual,
  fundingHourly,
  liqDistanceLabel,
  money,
  moneyShort,
  percent,
  percentAbs,
  signedMoney,
  tokenSize,
} from "../../../src/bot/lib/fmt.js";

// Normalize Intl spacing/minus glyphs so assertions aren't ICU-version-brittle.
const norm = (s: string) => s.replace(/ | /g, " ").replace(/−/g, "-");

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

describe("semantic money formatters", () => {
  it("money is exact with commas + 2dp", () => {
    expect(norm(money(1232222.2))).toBe("$1,232,222.20");
    expect(norm(money(0))).toBe("$0.00");
  });

  it("signedMoney shows sign except zero", () => {
    expect(norm(signedMoney(18))).toBe("+$18.00");
    expect(norm(signedMoney(-42.5))).toBe("-$42.50");
  });

  it("moneyShort compacts from 1,000 (no 100K cliff)", () => {
    expect(norm(moneyShort(940))).toBe("$940");
    expect(norm(moneyShort(50000))).toBe("$50K");
    expect(norm(moneyShort(1200000))).toBe("$1.2M");
  });

  it("compactSigned signs compact values", () => {
    expect(norm(compactSigned(138))).toBe("+138");
    expect(norm(compactSigned(-1200))).toBe("-1.2K");
  });

  it("compact strips trailing zeros", () => {
    expect(norm(compact(999))).toBe("999");
    expect(norm(compact(1000))).toBe("1K");
    expect(norm(compact(1234))).toBe("1.2K");
  });

  it("handles non-finite", () => {
    expect(money(Number.NaN)).toBe("$—");
    expect(compact(Number.NaN)).toBe("—");
  });
});

describe("percent / tokenSize", () => {
  it("percent signs and respects dp", () => {
    expect(norm(percent(12.5))).toBe("+12.50%");
    expect(norm(percent(-3))).toBe("-3.00%");
    expect(norm(percentAbs(5, 1))).toBe("5.0%");
  });

  it("tokenSize uses min(4, decimals) and optional symbol", () => {
    expect(norm(tokenSize(1.23456, 4))).toBe("1.2346");
    expect(norm(tokenSize(1.5, 5, "SOL"))).toBe("1.5 SOL");
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
