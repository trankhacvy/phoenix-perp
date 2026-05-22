import { describe, expect, it } from "vitest";
import { BotError, isBotError, toBotError } from "../../../src/bot/lib/errors.js";

describe("BotError", () => {
  it("constructs with all fields", () => {
    const e = new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "Bad input.",
      hint: "Try again.",
      retryable: true,
      meta: { foo: "bar" },
    });
    expect(e.category).toBe("validation");
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.userMessage).toBe("Bad input.");
    expect(e.hint).toBe("Try again.");
    expect(e.retryable).toBe(true);
    expect(e.meta).toEqual({ foo: "bar" });
    expect(e.name).toBe("BotError");
  });

  it("defaults retryable to false", () => {
    const e = new BotError({
      category: "internal",
      code: "UNKNOWN",
      userMessage: "x",
    });
    expect(e.retryable).toBe(false);
  });
});

describe("isBotError", () => {
  it("returns true only for BotError instances", () => {
    expect(
      isBotError(new BotError({ category: "internal", code: "UNKNOWN", userMessage: "x" })),
    ).toBe(true);
    expect(isBotError(new Error("plain"))).toBe(false);
    expect(isBotError("string")).toBe(false);
    expect(isBotError(null)).toBe(false);
  });
});

describe("toBotError SDK adapter", () => {
  it("passes through existing BotError unchanged", () => {
    const original = new BotError({
      category: "validation",
      code: "SIZE_TOO_SMALL",
      userMessage: "x",
    });
    expect(toBotError(original)).toBe(original);
  });

  it("classifies blockhash expiry as retryable", () => {
    const be = toBotError(new Error("blockhash not found"));
    expect(be.code).toBe("BLOCKHASH_EXPIRED");
    expect(be.category).toBe("tx_failed");
    expect(be.retryable).toBe(true);
  });

  it("classifies insufficient SOL", () => {
    const be = toBotError(new Error("insufficient SOL for gas"));
    expect(be.code).toBe("INSUFFICIENT_SOL");
    expect(be.retryable).toBe(false);
  });

  it("classifies Telegram 5xx as retryable network", () => {
    const be = toBotError(new Error("Telegram returned 502: Bad Gateway"));
    expect(be.code).toBe("NETWORK");
    expect(be.retryable).toBe(true);
  });

  it("does not match generic 'expired' substring (session expired)", () => {
    const be = toBotError(new Error("session expired, please re-authenticate"));
    expect(be.code).toBe("UNKNOWN");
  });

  it("does not match generic 'network' substring", () => {
    const be = toBotError(new Error("Phoenix network: market not found"));
    expect(be.code).toBe("UNKNOWN");
  });

  it("classifies insufficient margin", () => {
    const be = toBotError(new Error("insufficient collateral for this trade"));
    expect(be.code).toBe("INSUFFICIENT_MARGIN");
  });

  it("classifies missing trader account", () => {
    const be = toBotError(new Error("Trader account not found"));
    expect(be.code).toBe("NOT_REGISTERED");
    expect(be.category).toBe("auth");
  });

  it("classifies slippage as retryable", () => {
    const be = toBotError(new Error("price slippage exceeded"));
    expect(be.code).toBe("SLIPPAGE_EXCEEDED");
    expect(be.retryable).toBe(true);
  });

  it("classifies no position", () => {
    const be = toBotError(new Error("no open position for SOL"));
    expect(be.code).toBe("NO_POSITION");
  });

  it("classifies isolated-only market", () => {
    const be = toBotError(new Error("Isolated margin required"));
    expect(be.code).toBe("ISOLATED_ONLY_MARKET");
  });

  it("classifies rate limit as retryable", () => {
    const be = toBotError(new Error("429 rate limit"));
    expect(be.code).toBe("RATE_LIMIT");
    expect(be.retryable).toBe(true);
  });

  it("classifies network errors as retryable", () => {
    const be = toBotError(new Error("ECONNRESET"));
    expect(be.code).toBe("NETWORK");
    expect(be.retryable).toBe(true);
  });

  it("falls back to UNKNOWN for unmatched messages", () => {
    const be = toBotError(new Error("weird thing happened"));
    expect(be.code).toBe("UNKNOWN");
    expect(be.category).toBe("internal");
    expect(be.retryable).toBe(false);
  });

  it("handles non-Error inputs", () => {
    const be = toBotError("plain string");
    expect(be.code).toBe("UNKNOWN");
  });
});
