import { describe, expect, it } from "vitest";
import { computeTrailStop, dailyFundingPaid } from "../../../src/workers/evaluators/guardian.js";

describe("dailyFundingPaid", () => {
  it("is positive (cost) for a long when funding is positive", () => {
    expect(dailyFundingPaid("long", 36.5, 10_000)).toBeCloseTo(10, 5);
  });

  it("is negative (earning) for a short when funding is positive", () => {
    expect(dailyFundingPaid("short", 36.5, 10_000)).toBeCloseTo(-10, 5);
  });

  it("is positive (cost) for a short when funding is negative", () => {
    expect(dailyFundingPaid("short", -36.5, 10_000)).toBeCloseTo(10, 5);
  });

  it("never trips a funding_drain threshold when the position earns funding", () => {
    const threshold = 5;
    const paid = dailyFundingPaid("short", 36.5, 10_000);
    expect(paid >= threshold).toBe(false);
  });
});

describe("computeTrailStop", () => {
  it("places a long stop below the peak", () => {
    expect(computeTrailStop("long", 120, 5)).toBeCloseTo(114, 5);
  });

  it("places a short stop above the trough", () => {
    expect(computeTrailStop("short", 100, 5)).toBeCloseTo(105, 5);
  });

  it("ratchets up: higher peak gives a higher long stop", () => {
    const a = computeTrailStop("long", 120, 5);
    const b = computeTrailStop("long", 130, 5);
    expect(b).toBeGreaterThan(a);
  });
});
