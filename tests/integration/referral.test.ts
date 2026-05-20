import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { referrals, users } from "../../src/db/schema/index.js";
import { generateReferralCode, getReferralStats, linkReferral } from "../../src/services/referral.js";

const makeUser = (id: string, code: string) => ({
  id,
  telegramId: id,
  privyUserId: `privy-${id}`,
  walletAddress: `wallet-${id}`,
  referralCode: code,
  phoenixActivated: true as const,
});

describe("referral system", () => {
  beforeEach(async () => {
    await db.delete(referrals);
    await db.delete(users);
  });

  afterEach(async () => {
    await db.delete(referrals);
    await db.delete(users);
  });

  it("links T1 and T2 referrals correctly", async () => {
    await db.insert(users).values([
      makeUser("u1", "CODE1"),
      makeUser("u2", "CODE2"),
      makeUser("u3", "CODE3"),
    ]);

    await linkReferral("u2", "CODE1");
    await linkReferral("u3", "CODE2");

    const u1Stats = await getReferralStats("u1");
    expect(u1Stats.t1Count).toBe(1);
    expect(u1Stats.t2Count).toBe(1);

    const u2Stats = await getReferralStats("u2");
    expect(u2Stats.t1Count).toBe(1);
    expect(u2Stats.t2Count).toBe(0);
  });

  it("does not create self-referral", async () => {
    await db.insert(users).values([makeUser("u1", "CODE1")]);
    await linkReferral("u1", "CODE1");

    const stats = await getReferralStats("u1");
    expect(stats.t1Count).toBe(0);
  });

  it("does not chain T2 from a T2 parent", async () => {
    await db.insert(users).values([
      makeUser("u1", "CODE1"),
      makeUser("u2", "CODE2"),
      makeUser("u3", "CODE3"),
      makeUser("u4", "CODE4"),
    ]);

    await linkReferral("u2", "CODE1");
    await linkReferral("u3", "CODE2");
    await linkReferral("u4", "CODE3");

    const u1Stats = await getReferralStats("u1");
    expect(u1Stats.t1Count).toBe(1);
    expect(u1Stats.t2Count).toBe(1);

    const u2Stats = await getReferralStats("u2");
    expect(u2Stats.t1Count).toBe(1);
    expect(u2Stats.t2Count).toBe(0);
  });

  it("generateReferralCode is 8-char uppercase hex", () => {
    const code = generateReferralCode();
    expect(code).toMatch(/^[A-F0-9]{8}$/);
  });
});
