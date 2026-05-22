import { describe, expect, it } from "vitest";
import { redactArgs } from "../../../src/services/action-log.js";

describe("redactArgs", () => {
  it("redacts top-level sensitive keys", () => {
    expect(redactArgs({ password: "hunter2", symbol: "SOL" })).toEqual({
      password: "[REDACTED]",
      symbol: "SOL",
    });
  });

  it("redacts every known secret key", () => {
    const out = redactArgs({
      password: "x",
      privateKey: "x",
      private_key: "x",
      apiKey: "x",
      api_key: "x",
      secret: "x",
      token: "x",
      mnemonic: "x",
      seed: "x",
      keep: "stay",
    });
    expect(out.keep).toBe("stay");
    for (const k of [
      "password",
      "privateKey",
      "private_key",
      "apiKey",
      "api_key",
      "secret",
      "token",
      "mnemonic",
      "seed",
    ]) {
      expect(out[k]).toBe("[REDACTED]");
    }
  });

  it("recurses into nested objects", () => {
    const out = redactArgs({
      meta: { token: "x", inner: { password: "x" } },
      symbol: "SOL",
    });
    expect(out).toEqual({
      meta: { token: "[REDACTED]", inner: { password: "[REDACTED]" } },
      symbol: "SOL",
    });
  });

  it("recurses into arrays of objects", () => {
    const out = redactArgs({ list: [{ password: "x", keep: "ok" }] });
    expect(out.list).toEqual([{ password: "[REDACTED]", keep: "ok" }]);
  });

  it("converts Date to ISO string", () => {
    const d = new Date("2024-01-15T10:30:00Z");
    const out = redactArgs({ when: d });
    expect(out.when).toBe(d.toISOString());
  });

  it("stringifies Error instances safely", () => {
    const out = redactArgs({ err: new TypeError("boom") });
    expect(out.err).toBe("TypeError: boom");
  });

  it("stringifies bigint", () => {
    const out = redactArgs({ amount: 12345n });
    expect(out.amount).toBe("12345");
  });

  it("handles null and primitives", () => {
    expect(redactArgs({ x: null, y: 1, z: true, s: "str" })).toEqual({
      x: null,
      y: 1,
      z: true,
      s: "str",
    });
  });
});
