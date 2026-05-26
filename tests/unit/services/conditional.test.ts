import { Side } from "@ellipsis-labs/rise";
import { describe, expect, it } from "vitest";
import { BotError } from "../../../src/bot/lib/errors.js";
import {
  type ConditionalRung,
  type ResolvedRung,
  computeMarketExecutionTicks,
  findCancelDescriptors,
  parseConditionalId,
  priceUsdToTicksBig,
  resolveRungs,
  resolveSize,
  sideOfBaseLots,
  subtractCancelled,
  ticksToPriceUsd,
  validateMode,
  validateSize,
  validateSizes,
  validateTriggerPrice,
} from "../../../src/services/phoenix/conditional.js";

const SOL_MARKET = { tickSize: 1, baseLotsDecimals: 5, assetId: 7 };
const BTC_MARKET = { tickSize: 1, baseLotsDecimals: 8, assetId: 1 };

const longPos = { markPrice: "100", liquidationPrice: "85" };
const shortPos = { markPrice: "100", liquidationPrice: "115" };

describe("sideOfBaseLots", () => {
  it("treats negative as short", () => {
    expect(sideOfBaseLots("-1145000")).toBe("short");
  });
  it("treats positive as long", () => {
    expect(sideOfBaseLots("1145000")).toBe("long");
  });
  it("treats zero as long (degenerate)", () => {
    expect(sideOfBaseLots("0")).toBe("long");
  });
  it("trims whitespace", () => {
    expect(sideOfBaseLots("  -42")).toBe("short");
  });
});

describe("parseConditionalId", () => {
  it("parses tp gt with matching asset id", () => {
    const r = parseConditionalId("ctp-7-3-gt", "tp", 7);
    expect(r).toEqual({ conditionalOrderIndex: 3, triggerDirection: "greater_than" });
  });

  it("parses sl lt with matching asset id", () => {
    const r = parseConditionalId("csl-7-0-lt", "sl", 7);
    expect(r).toEqual({ conditionalOrderIndex: 0, triggerDirection: "less_than" });
  });

  it("rejects when prefix mismatches expected leg", () => {
    expect(parseConditionalId("ctp-7-3-gt", "sl", 7)).toBeNull();
    expect(parseConditionalId("csl-7-3-gt", "tp", 7)).toBeNull();
  });

  it("rejects on wrong asset id", () => {
    expect(parseConditionalId("ctp-7-3-gt", "tp", 8)).toBeNull();
  });

  it("rejects NaN index", () => {
    expect(parseConditionalId("ctp-7-abc-gt", "tp", 7)).toBeNull();
  });

  it("rejects negative index", () => {
    expect(parseConditionalId("ctp-7--1-gt", "tp", 7)).toBeNull();
  });

  it("rejects missing parts", () => {
    expect(parseConditionalId("ctp-7-3", "tp", 7)).toBeNull();
  });

  it("rejects extra parts", () => {
    expect(parseConditionalId("ctp-7-3-gt-extra", "tp", 7)).toBeNull();
  });

  it("rejects unknown direction", () => {
    expect(parseConditionalId("ctp-7-3-zz", "tp", 7)).toBeNull();
  });

  it("rejects entirely malformed strings", () => {
    expect(parseConditionalId("weird", "tp", 7)).toBeNull();
    expect(parseConditionalId("", "tp", 7)).toBeNull();
  });
});

describe("resolveSize", () => {
  it("full → positionLots", () => {
    expect(resolveSize({ kind: "full" }, 1_145_000n, SOL_MARKET)).toBe(1_145_000n);
  });
  it("lots passthrough", () => {
    expect(resolveSize({ kind: "lots", lots: 123n }, 1_145_000n, SOL_MARKET)).toBe(123n);
  });
  it("tokens 1.5 SOL @ 5 decimals = 150000 lots", () => {
    expect(resolveSize({ kind: "tokens", tokens: 1.5 }, 0n, SOL_MARKET)).toBe(150_000n);
  });
  it("tokens 0.00000001 BTC @ 8 decimals = 1 lot", () => {
    expect(resolveSize({ kind: "tokens", tokens: 0.00000001 }, 0n, BTC_MARKET)).toBe(1n);
  });
  it("percent 50 of 1000 lots = 500", () => {
    expect(resolveSize({ kind: "percent", pct: 50 }, 1000n, SOL_MARKET)).toBe(500n);
  });
  it("percent 33 of 1000 lots = 330", () => {
    expect(resolveSize({ kind: "percent", pct: 33 }, 1000n, SOL_MARKET)).toBe(330n);
  });
  it("percent > 100 returns 0", () => {
    expect(resolveSize({ kind: "percent", pct: 101 }, 1000n, SOL_MARKET)).toBe(0n);
  });
  it("tokens 0 returns 0", () => {
    expect(resolveSize({ kind: "tokens", tokens: 0 }, 0n, SOL_MARKET)).toBe(0n);
  });
});

describe("validateTriggerPrice", () => {
  it("long TP above mark passes", () => {
    expect(() => validateTriggerPrice(110, "tp", "long", longPos)).not.toThrow();
  });
  it("long TP at or below mark throws", () => {
    expect(() => validateTriggerPrice(100, "tp", "long", longPos)).toThrow(BotError);
    expect(() => validateTriggerPrice(99, "tp", "long", longPos)).toThrow(BotError);
  });
  it("short TP below mark passes", () => {
    expect(() => validateTriggerPrice(90, "tp", "short", shortPos)).not.toThrow();
  });
  it("short TP at or above mark throws", () => {
    expect(() => validateTriggerPrice(100, "tp", "short", shortPos)).toThrow(BotError);
  });
  it("long SL below mark and above liq passes", () => {
    expect(() => validateTriggerPrice(92, "sl", "long", longPos)).not.toThrow();
  });
  it("long SL at or below liq throws", () => {
    expect(() => validateTriggerPrice(85, "sl", "long", longPos)).toThrow(BotError);
    expect(() => validateTriggerPrice(80, "sl", "long", longPos)).toThrow(BotError);
  });
  it("long SL above mark throws", () => {
    expect(() => validateTriggerPrice(105, "sl", "long", longPos)).toThrow(BotError);
  });
  it("short SL above mark and below liq passes", () => {
    expect(() => validateTriggerPrice(108, "sl", "short", shortPos)).not.toThrow();
  });
  it("short SL at or above liq throws", () => {
    expect(() => validateTriggerPrice(115, "sl", "short", shortPos)).toThrow(BotError);
  });
  it("non-positive price always throws", () => {
    expect(() => validateTriggerPrice(0, "tp", "long", longPos)).toThrow(BotError);
    expect(() => validateTriggerPrice(-1, "tp", "long", longPos)).toThrow(BotError);
    expect(() => validateTriggerPrice(Number.NaN, "tp", "long", longPos)).toThrow(BotError);
  });
  it("ignores liq when N/A", () => {
    const pos = { markPrice: "100", liquidationPrice: "N/A" };
    expect(() => validateTriggerPrice(50, "sl", "long", pos)).not.toThrow();
  });
});

describe("validateMode", () => {
  it("accepts limit and market", () => {
    expect(() => validateMode("limit")).not.toThrow();
    expect(() => validateMode("market")).not.toThrow();
  });
  it("rejects everything else", () => {
    expect(() => validateMode("ioc")).toThrow(BotError);
    expect(() => validateMode("")).toThrow(BotError);
  });
});

describe("validateSize", () => {
  it("happy path returns lots", () => {
    expect(validateSize({ kind: "lots", lots: 500n }, 1000n, 1000n, SOL_MARKET)).toBe(500n);
  });
  it("rejects zero", () => {
    expect(() => validateSize({ kind: "lots", lots: 0n }, 1000n, 1000n, SOL_MARKET)).toThrow(
      BotError,
    );
  });
  it("rejects size > remaining", () => {
    expect(() => validateSize({ kind: "lots", lots: 1001n }, 1000n, 1000n, SOL_MARKET)).toThrow(
      BotError,
    );
  });
});

describe("validateSizes", () => {
  const positionLots = 1000n;
  const existingTp: ConditionalRung = {
    leg: "tp",
    triggerPrice: 110,
    executionPrice: 110,
    conditionalOrderIndex: 0,
    triggerDirection: "greater_than",
    maxSizeLots: 400n,
    fillableSizeLots: 400n,
    filledSizeLots: 0n,
    mode: "limit",
    rawId: "ctp-7-0-gt",
  };

  it("accepts when total == position", () => {
    const tp: ResolvedRung[] = [
      { leg: "tp", triggerPrice: 115, mode: "limit", sizeLots: 600n },
    ];
    expect(() => validateSizes([existingTp], tp, [], positionLots)).not.toThrow();
  });

  it("rejects when total > position", () => {
    const tp: ResolvedRung[] = [
      { leg: "tp", triggerPrice: 115, mode: "limit", sizeLots: 601n },
    ];
    expect(() => validateSizes([existingTp], tp, [], positionLots)).toThrow(BotError);
  });

  it("checks SL independently of TP", () => {
    const sl: ResolvedRung[] = [
      { leg: "sl", triggerPrice: 85, mode: "market", sizeLots: 1500n },
    ];
    expect(() => validateSizes([], [], sl, positionLots)).toThrow(BotError);
  });
});

describe("resolveRungs", () => {
  it("rejects mix of full + multi", () => {
    const inputs = [
      { leg: "tp" as const, triggerPrice: 110, mode: "limit" as const, size: { kind: "full" as const } },
      {
        leg: "tp" as const,
        triggerPrice: 120,
        mode: "limit" as const,
        size: { kind: "lots" as const, lots: 100n },
      },
    ];
    expect(() => resolveRungs(inputs, 1000n, SOL_MARKET, "long", longPos)).toThrow(BotError);
  });

  it("allows multiple explicit-size rungs", () => {
    const inputs = [
      {
        leg: "tp" as const,
        triggerPrice: 110,
        mode: "limit" as const,
        size: { kind: "lots" as const, lots: 500n },
      },
      {
        leg: "tp" as const,
        triggerPrice: 120,
        mode: "limit" as const,
        size: { kind: "lots" as const, lots: 500n },
      },
    ];
    const out = resolveRungs(inputs, 1000n, SOL_MARKET, "long", longPos);
    expect(out).toHaveLength(2);
    expect(out[0].sizeLots).toBe(500n);
    expect(out[1].sizeLots).toBe(500n);
  });

  it("propagates trigger-price validation", () => {
    const inputs = [
      {
        leg: "tp" as const,
        triggerPrice: 90,
        mode: "limit" as const,
        size: { kind: "full" as const },
      },
    ];
    expect(() => resolveRungs(inputs, 1000n, SOL_MARKET, "long", longPos)).toThrow(BotError);
  });
});

describe("computeMarketExecutionTicks", () => {
  it("Ask close (long) uses 0.9× trigger", () => {
    expect(computeMarketExecutionTicks(1000n, Side.Ask)).toBe(900n);
  });
  it("Bid close (short) uses 1.1× trigger", () => {
    expect(computeMarketExecutionTicks(1000n, Side.Bid)).toBe(1100n);
  });
  it("floors", () => {
    expect(computeMarketExecutionTicks(7n, Side.Ask)).toBe(6n);
  });
});

describe("ticksToPriceUsd / priceUsdToTicksBig roundtrip", () => {
  it("SOL 87 → ticks → 87", () => {
    const ticks = priceUsdToTicksBig(87, SOL_MARKET);
    expect(ticksToPriceUsd(ticks, SOL_MARKET)).toBeCloseTo(87, 4);
  });

  it("BTC 50000 → ticks → 50000", () => {
    const ticks = priceUsdToTicksBig(50_000, BTC_MARKET);
    expect(ticksToPriceUsd(ticks, BTC_MARKET)).toBeCloseTo(50_000, 4);
  });
});

describe("findCancelDescriptors / subtractCancelled", () => {
  const rungs: ConditionalRung[] = [
    {
      leg: "tp",
      triggerPrice: 110,
      executionPrice: 110,
      conditionalOrderIndex: 0,
      triggerDirection: "greater_than",
      maxSizeLots: 500n,
      fillableSizeLots: 500n,
      filledSizeLots: 0n,
      mode: "limit",
      rawId: "ctp-7-0-gt",
    },
    {
      leg: "tp",
      triggerPrice: 120,
      executionPrice: 120,
      conditionalOrderIndex: 1,
      triggerDirection: "greater_than",
      maxSizeLots: 500n,
      fillableSizeLots: 500n,
      filledSizeLots: 0n,
      mode: "limit",
      rawId: "ctp-7-1-gt",
    },
    {
      leg: "sl",
      triggerPrice: 90,
      executionPrice: 81,
      conditionalOrderIndex: 2,
      triggerDirection: "less_than",
      maxSizeLots: 1000n,
      fillableSizeLots: 1000n,
      filledSizeLots: 0n,
      mode: "market",
      rawId: "csl-7-2-lt",
    },
  ];

  it("descriptors only for found indices", () => {
    const out = findCancelDescriptors(rungs, "tp", [0, 99]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ conditionalOrderIndex: 0, executionDirection: "greater_than" });
  });

  it("subtract removes by leg + index", () => {
    const rem = subtractCancelled(rungs, [0], [2]);
    expect(rem).toHaveLength(1);
    expect(rem[0].conditionalOrderIndex).toBe(1);
  });

  it("subtract no-op when arrays missing", () => {
    expect(subtractCancelled(rungs, undefined, undefined)).toHaveLength(3);
  });
});
