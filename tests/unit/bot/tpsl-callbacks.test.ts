import { describe, expect, it } from "vitest";

// Regression: every callback string produced by tpsl.ts must stay ≤ 64 bytes.
// We sample worst-case parameters: long symbol (WTIOIL), side=short, idx=255,
// price with all 8 decimals, lots up to a 16-digit decimal, mode=market.

const WORST_SYM = "WTIOIL";
const WORST_SIDE = "short";
const WORST_IDX = 255;
const WORST_PRICE = "99999.99999999"; // 14 chars
const WORST_LOTS = "9999999999999999"; // 16 chars (u64-ish)
const WORST_MODE = "market";

const TEMPLATES = [
  `tpsl:open:tp:${WORST_SYM}:${WORST_SIDE}`,
  `tpsl:open:sl:${WORST_SYM}:${WORST_SIDE}`,
  `tpsl:add:tp:${WORST_SYM}:${WORST_SIDE}`,
  `tpsl:px:tp:${WORST_SYM}:${WORST_SIDE}:50`,
  `tpsl:px2:tp:${WORST_SYM}:${WORST_SIDE}:50`,
  `tpsl:pxc:tp:${WORST_SYM}:${WORST_SIDE}`,
  `tpsl:sz:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_PRICE}:100`,
  `tpsl:szc:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_PRICE}`,
  `tpsl:md:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_PRICE}:${WORST_LOTS}:${WORST_MODE}`,
  `tpsl:go:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_PRICE}:${WORST_LOTS}:${WORST_MODE}`,
  `tpsl:row:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_IDX}`,
  `tpsl:rm:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_IDX}`,
  `tpsl:rmgo:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_IDX}`,
  `tpsl:clr:tp:${WORST_SYM}:${WORST_SIDE}`,
  `tpsl:clrgo:tp:${WORST_SYM}:${WORST_SIDE}`,
  `tpsl:flipmd:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_IDX}`,
  `tpsl:editpx:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_IDX}`,
  `tpsl:editsz:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_IDX}`,
  `tpsl:split:tp:${WORST_SYM}:${WORST_SIDE}`,
  `tpsl:splitgo:tp:${WORST_SYM}:${WORST_SIDE}:${WORST_IDX}:${WORST_PRICE}`,
];

describe("tpsl callback length", () => {
  for (const cb of TEMPLATES) {
    it(`${cb.split(":").slice(0, 2).join(":")} ≤ 64 bytes`, () => {
      expect(Buffer.byteLength(cb, "utf8")).toBeLessThanOrEqual(64);
    });
  }
});
