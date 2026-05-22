import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/services/phoenix/market.js", () => ({
  getMarketSnapshot: vi.fn(),
  isIsolatedOnly: vi.fn((s: string) => s.toUpperCase() === "GOLD"),
}));
vi.mock("../../../src/services/phoenix/position.js", () => ({
  getTraderState: vi.fn(),
}));
vi.mock("../../../src/db/index.js", () => ({
  db: {
    query: {
      userSettings: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
}));

import { BotError } from "../../../src/bot/lib/errors.js";
import type { User } from "../../../src/db/schema/users.js";
import { getMarketSnapshot } from "../../../src/services/phoenix/market.js";
import { getTraderState } from "../../../src/services/phoenix/position.js";
import { preflightOpen } from "../../../src/services/phoenix/preflight.js";

const baseUser: User = {
  id: "u1",
  telegramId: "u1",
  username: null,
  firstName: null,
  privyUserId: "p1",
  walletAddress: "WALLET",
  phoenixActivated: true,
  referralCode: null,
  referredBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseSnap = {
  symbol: "SOL",
  markPrice: 100,
  tickSize: 0.01,
  baseLotsDecimals: 4,
  maxLeverage: 50,
  takerFee: 0.00035,
  makerFee: 0.0002,
  fundingRate: 0,
  openInterest: "0",
  isIsolatedOnly: false,
  leverageTiers: [{ maxLeverage: 50, maxNotionalUsdc: 10_000 }],
};

const snapMock = getMarketSnapshot as unknown as ReturnType<typeof vi.fn>;
const stateMock = getTraderState as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  snapMock.mockResolvedValue(baseSnap);
  stateMock.mockResolvedValue({ effectiveCollateral: "10000" });
});

describe("preflightOpen", () => {
  it("rejects unactivated users", async () => {
    await expect(
      preflightOpen({
        user: { ...baseUser, phoenixActivated: false },
        symbol: "SOL",
        side: "long",
        marginUsdc: 100,
        leverage: 5,
      }),
    ).rejects.toMatchObject({ code: "PHOENIX_NOT_ACTIVATED" });
  });

  it("rejects isolated-only markets", async () => {
    await expect(
      preflightOpen({
        user: baseUser,
        symbol: "GOLD",
        side: "long",
        marginUsdc: 100,
        leverage: 5,
      }),
    ).rejects.toMatchObject({ code: "ISOLATED_ONLY_MARKET" });
  });

  it("rejects bad margin input", async () => {
    await expect(
      preflightOpen({
        user: baseUser,
        symbol: "SOL",
        side: "long",
        marginUsdc: 0,
        leverage: 5,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects leverage below 1", async () => {
    await expect(
      preflightOpen({
        user: baseUser,
        symbol: "SOL",
        side: "long",
        marginUsdc: 100,
        leverage: 0,
      }),
    ).rejects.toMatchObject({ code: "LEV_OUT_OF_RANGE" });
  });

  it("rejects unknown market", async () => {
    snapMock.mockRejectedValueOnce(new Error("market not found"));
    await expect(
      preflightOpen({
        user: baseUser,
        symbol: "DOGE",
        side: "long",
        marginUsdc: 100,
        leverage: 5,
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_MARKET" });
  });

  it("rejects when collateral cannot cover margin + fee", async () => {
    stateMock.mockResolvedValueOnce({ effectiveCollateral: "10" });
    await expect(
      preflightOpen({
        user: baseUser,
        symbol: "SOL",
        side: "long",
        marginUsdc: 100,
        leverage: 5,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_MARGIN" });
  });

  it("rejects when notional exceeds tier cap", async () => {
    snapMock.mockResolvedValueOnce({
      ...baseSnap,
      leverageTiers: [{ maxLeverage: 50, maxNotionalUsdc: 1_000 }],
    });
    await expect(
      preflightOpen({
        user: baseUser,
        symbol: "SOL",
        side: "long",
        marginUsdc: 100,
        leverage: 20,
      }),
    ).rejects.toMatchObject({ code: "TIER_OVERFLOW" });
  });

  it("rejects when leverage exceeds tier max for given notional", async () => {
    snapMock.mockResolvedValueOnce({
      ...baseSnap,
      leverageTiers: [
        { maxLeverage: 5, maxNotionalUsdc: 5_000 },
        { maxLeverage: 50, maxNotionalUsdc: 10_000 },
      ],
    });
    await expect(
      preflightOpen({
        user: baseUser,
        symbol: "SOL",
        side: "long",
        marginUsdc: 100,
        leverage: 25,
      }),
    ).rejects.toMatchObject({ code: "TIER_OVERFLOW" });
  });

  it("rejects when anchor price drifts beyond slippage", async () => {
    snapMock.mockResolvedValueOnce({ ...baseSnap, markPrice: 102 });
    await expect(
      preflightOpen({
        user: baseUser,
        symbol: "SOL",
        side: "long",
        marginUsdc: 100,
        leverage: 5,
        anchorPrice: 100,
      }),
    ).rejects.toMatchObject({ code: "PRICE_DRIFT", retryable: true });
  });

  it("allows trade within all bounds and returns derived figures", async () => {
    const result = await preflightOpen({
      user: baseUser,
      symbol: "SOL",
      side: "long",
      marginUsdc: 100,
      leverage: 5,
    });
    expect(result.effectiveLeverage).toBe(5);
    expect(result.notional).toBe(500);
    expect(result.feeUsdc).toBeGreaterThan(0);
    expect(result.liqPrice).toBeLessThan(baseSnap.markPrice);
  });

  it("caps leverage at market max instead of rejecting", async () => {
    const result = await preflightOpen({
      user: baseUser,
      symbol: "SOL",
      side: "long",
      marginUsdc: 100,
      leverage: 9999,
    });
    expect(result.effectiveLeverage).toBe(baseSnap.maxLeverage);
  });
});
