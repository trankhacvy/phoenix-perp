import { describe, expect, it } from "vitest";

const WORST_SYM = "WTIOIL";
const WORST_SIDE = "short";
const WORST_RULE_ID = "a1b2c3d4";
const WORST_AMOUNT = "99999";
const WORST_PCT = "75";
const WORST_THRESHOLD = "99999.9999";

const TEMPLATES = [
  `grd:list`,
  `grd:new`,
  `grd:preset`,
  `grd:presetgo:conservative`,
  `grd:presetgo:moderate`,
  `grd:presetgo:aggressive`,
  `grd:type:exposure_limit`,
  `grd:type:drawdown`,
  `grd:sym:drawdown:${WORST_SYM}`,
  `grd:sym:drawdown:_all`,
  `grd:th:drawdown:${WORST_SYM}:20`,
  `grd:th:pnl_target:${WORST_SYM}:+200`,
  `grd:th:pnl_target:${WORST_SYM}:-50`,
  `grd:thc:drawdown:${WORST_SYM}`,
  `grd:act:drawdown:${WORST_SYM}:20:notify`,
  `grd:act:drawdown:${WORST_SYM}:20:suggest`,
  `grd:act:drawdown:${WORST_SYM}:20:auto_close`,
  `grd:act:drawdown:${WORST_SYM}:20:auto_reduce`,
  `grd:act:drawdown:${WORST_SYM}:20:auto_margin`,
  `grd:autoparam:drawdown:${WORST_SYM}:20:auto_reduce:${WORST_PCT}`,
  `grd:margincustom:drawdown:${WORST_SYM}:20`,
  `grd:save:drawdown:${WORST_SYM}:${WORST_THRESHOLD}:suggest:`,
  `grd:save:drawdown:${WORST_SYM}:${WORST_THRESHOLD}:auto_reduce:${WORST_PCT}`,
  `grd:edit:${WORST_RULE_ID}`,
  `grd:edit:th:${WORST_RULE_ID}`,
  `grd:edit:act:${WORST_RULE_ID}`,
  `grd:toggle:${WORST_RULE_ID}`,
  `grd:rm:${WORST_RULE_ID}`,
  `grd:rmgo:${WORST_RULE_ID}`,
  `grd:killswitch`,
  `grd:killgo`,
  `grd:close:${WORST_SYM}:${WORST_SIDE}`,
  `grd:closego:${WORST_SYM}:${WORST_SIDE}`,
  `grd:reduce:${WORST_SYM}:${WORST_SIDE}:${WORST_PCT}`,
  `grd:reducego:${WORST_SYM}:${WORST_SIDE}:${WORST_PCT}`,
  `grd:margin:${WORST_SYM}:${WORST_AMOUNT}`,
  `grd:margingo:${WORST_SYM}:${WORST_AMOUNT}`,
  `grd:snooze:${WORST_RULE_ID}:30`,
  `grd:close_menu`,
  `al:main`,
  `al:acct`,
  `al:toggle:at_risk`,
  `al:toggle:liquidatable`,
  `al:prices`,
  `al:pa:add`,
  `al:pa:add:${WORST_SYM}`,
  `al:pa:exec:${WORST_SYM}:${WORST_THRESHOLD}:above`,
  `al:pa:exec:${WORST_SYM}:${WORST_THRESHOLD}:below`,
  `al:pa:rm:${crypto.randomUUID()}`,
  `al:pa:rmall`,
  `al:pa:rmallgo`,
  `al:pa:reenable:${crypto.randomUUID()}`,
  `mon:list`,
  `mon:add`,
  `mon:settings:${crypto.randomUUID()}`,
  `mon:toggle:pos:${crypto.randomUUID()}`,
  `mon:toggle:fill:${crypto.randomUUID()}`,
  `mon:label:${crypto.randomUUID()}`,
  `mon:rm:${crypto.randomUUID()}`,
  `mon:rmgo:${crypto.randomUUID()}`,
];

describe("guardian/alerts/monitor callback length", () => {
  for (const cb of TEMPLATES) {
    it(`${cb.slice(0, 40)}${cb.length > 40 ? "…" : ""} ≤ 64 bytes`, () => {
      expect(Buffer.byteLength(cb, "utf8")).toBeLessThanOrEqual(64);
    });
  }
});
