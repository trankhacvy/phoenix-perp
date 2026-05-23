import { describe, expect, it, vi, beforeEach } from "vitest";

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
vi.mock("../../../src/lib/redis.js", () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
  },
}));
vi.mock("../../../src/bot/lib/pending.js", () => ({
  setPending: vi.fn(),
  getPending: vi.fn(),
  clearPending: vi.fn(),
}));

import { getMarketSnapshot } from "../../../src/services/phoenix/market.js";
import { getTraderState } from "../../../src/services/phoenix/position.js";
import { redis } from "../../../src/lib/redis.js";
import { parseLeverage } from "../../../src/bot/lib/fmt.js";
import { checkOrderRateLimit } from "../../../src/bot/middleware/rate-limit.js";
import type { BotContext } from "../../../src/types/index.js";
import type { User } from "../../../src/db/schema/users.js";

const snapMock = getMarketSnapshot as unknown as ReturnType<typeof vi.fn>;
const stateMock = getTraderState as unknown as ReturnType<typeof vi.fn>;
const redisMock = redis as unknown as { incr: ReturnType<typeof vi.fn>; expire: ReturnType<typeof vi.fn> };

const baseSnap = {
  symbol: "BTC",
  markPrice: 87000,
  tickSize: 0.01,
  baseLotsDecimals: 4,
  maxLeverage: 20,
  takerFee: 0.00035,
  makerFee: 0.0002,
  fundingRate: 0,
  openInterest: "0",
  isIsolatedOnly: false,
  leverageTiers: [{ maxLeverage: 20, maxNotionalUsdc: 100_000 }],
};

const baseUser: User = {
  id: "u1",
  telegramId: "100",
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

function makeCtx(overrides?: Partial<BotContext>): BotContext {
  const replies: string[] = [];
  return {
    user: baseUser,
    from: { id: 100 },
    reply: vi.fn(async (text: string) => { replies.push(text); }),
    answerCallbackQuery: vi.fn(),
    callbackQuery: null,
    actionLog: {},
    ...overrides,
  } as unknown as BotContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  snapMock.mockResolvedValue(baseSnap);
  stateMock.mockResolvedValue({ effectiveCollateral: "500" });
  redisMock.incr.mockResolvedValue(1);
  redisMock.expire.mockResolvedValue(1);
});

describe("parseLeverage", () => {
  it("accepts decimal leverage like 2.5x", () => {
    const lev = parseLeverage("2.5x");
    expect(lev).toBe(2.5);
    expect(Number.isFinite(lev)).toBe(true);
    expect(lev >= 1).toBe(true);
  });

  it("accepts integer without suffix", () => {
    expect(parseLeverage("10")).toBe(10);
  });

  it("rejects Infinity (guard via !Number.isFinite)", () => {
    const lev = parseLeverage("Infinityx");
    expect(Number.isFinite(lev)).toBe(false);
  });

  it("rejects NaN strings", () => {
    expect(Number.isNaN(parseLeverage("abc"))).toBe(true);
  });
});

describe("checkOrderRateLimit", () => {
  it("returns true when under limit", async () => {
    redisMock.incr.mockResolvedValue(3);
    const ctx = makeCtx();
    const result = await checkOrderRateLimit(ctx);
    expect(result).toBe(true);
  });

  it("returns false and answers callback on 6th call", async () => {
    redisMock.incr.mockResolvedValue(6);
    const ctx = makeCtx({
      callbackQuery: {} as NonNullable<BotContext["callbackQuery"]>,
    });
    const result = await checkOrderRateLimit(ctx);
    expect(result).toBe(false);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Too many orders. Wait a minute.");
  });

  it("returns false and sends reply when not a callback", async () => {
    redisMock.incr.mockResolvedValue(6);
    const ctx = makeCtx({ callbackQuery: null });
    const result = await checkOrderRateLimit(ctx);
    expect(result).toBe(false);
    expect(ctx.reply).toHaveBeenCalledWith("Too many orders. Wait a minute.");
  });

  it("sets expire on first call", async () => {
    redisMock.incr.mockResolvedValue(1);
    const ctx = makeCtx();
    await checkOrderRateLimit(ctx);
    expect(redisMock.expire).toHaveBeenCalled();
  });

  it("does not set expire on subsequent calls", async () => {
    redisMock.incr.mockResolvedValue(2);
    const ctx = makeCtx();
    await checkOrderRateLimit(ctx);
    expect(redisMock.expire).not.toHaveBeenCalled();
  });
});
