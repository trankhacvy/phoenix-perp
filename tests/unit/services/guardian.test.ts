import { describe, expect, it } from "vitest";
import { generateRuleId } from "../../../src/services/guardian.js";

describe("generateRuleId", () => {
  it("generates 8-char lowercase hex string", () => {
    const id = generateRuleId();
    expect(id).toMatch(/^[a-f0-9]{8}$/);
  });

  it("generates unique IDs across 100 calls", () => {
    const ids = new Set(Array.from({ length: 100 }, generateRuleId));
    expect(ids.size).toBe(100);
  });

  it("fits in callback budget (≤ 64 bytes total with longest callback prefix)", () => {
    const id = generateRuleId();
    const longestCallback = `grd:snooze:${id}:30`;
    expect(Buffer.byteLength(longestCallback, "utf8")).toBeLessThanOrEqual(64);
  });
});
