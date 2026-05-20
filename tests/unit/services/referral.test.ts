import { describe, expect, it } from "vitest";
import { generateReferralCode } from "../../../src/services/referral.js";

describe("generateReferralCode", () => {
  it("generates 8-char uppercase hex string", () => {
    const code = generateReferralCode();
    expect(code).toMatch(/^[A-F0-9]{8}$/);
  });

  it("generates unique codes across 100 calls", () => {
    const codes = new Set(Array.from({ length: 100 }, generateReferralCode));
    expect(codes.size).toBe(100);
  });
});
