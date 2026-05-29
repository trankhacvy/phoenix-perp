import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { referrals, users } from "../../src/db/schema/index.js";
import {
  accrueReferralPoints,
  generateReferralCode,
  getReferralStats,
  linkReferral,
} from "../../src/services/referral.js";

const makeUser = (id: string, code: string) => ({
  id,
  telegramId: id,
  privyUserId: `privy-${id}`,
  walletAddress: `wallet-${id}`,
  referralCode: code,
  phoenixActivated: true as const,
});

describe("referral system (single-tier, points)", () => {
  beforeEach(async () => {
    await db.delete(referrals);
    await db.delete(users);
  });

  afterEach(async () => {
    await db.delete(referrals);
    await db.delete(users);
  });

  it("links a single-tier (T1) referral and never chains to T2", async () => {
    await db.insert(users).values([
      makeUser("u1", "CODE1"),
      makeUser("u2", "CODE2"),
      makeUser("u3", "CODE3"),
    ]);

    await linkReferral("u2", "CODE1");
    await linkReferral("u3", "CODE2");

    const u1Stats = await getReferralStats("u1");
    expect(u1Stats.referralCount).toBe(1);

    const u2Stats = await getReferralStats("u2");
    expect(u2Stats.referralCount).toBe(1);

    // No T2 rows are ever created.
    const all = await db.select().from(referrals);
    expect(all.every((r) => r.tier === "t1")).toBe(true);
  });

  it("does not create self-referral", async () => {
    await db.insert(users).values([makeUser("u1", "CODE1")]);
    await linkReferral("u1", "CODE1");

    const stats = await getReferralStats("u1");
    expect(stats.referralCount).toBe(0);
  });

  it("accrues points (1 point per $1 of referee volume) to the direct referrer", async () => {
    await db.insert(users).values([makeUser("u1", "CODE1"), makeUser("u2", "CODE2")]);
    await linkReferral("u2", "CODE1");

    await accrueReferralPoints("u2", 1000);
    await accrueReferralPoints("u2", 250.5);

    const stats = await getReferralStats("u1");
    expect(stats.points).toBeCloseTo(1250.5, 4);
    expect(stats.rank).toBe(1);
  });

  it("ranks referrers by total points", async () => {
    await db.insert(users).values([
      makeUser("u1", "CODE1"),
      makeUser("u2", "CODE2"),
      makeUser("u3", "CODE3"),
      makeUser("u4", "CODE4"),
    ]);
    await linkReferral("u3", "CODE1"); // u1 refers u3
    await linkReferral("u4", "CODE2"); // u2 refers u4

    await accrueReferralPoints("u3", 500); // u1 -> 500 pts
    await accrueReferralPoints("u4", 2000); // u2 -> 2000 pts

    const u1Stats = await getReferralStats("u1");
    const u2Stats = await getReferralStats("u2");
    expect(u2Stats.rank).toBe(1);
    expect(u1Stats.rank).toBe(2);
    expect(u1Stats.totalReferrers).toBe(2);
  });

  it("generateReferralCode is 8-char uppercase hex", () => {
    const code = generateReferralCode();
    expect(code).toMatch(/^[A-F0-9]{8}$/);
  });
});
