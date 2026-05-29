import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { referrals, users } from "../db/schema/index.js";

export function generateReferralCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

/**
 * Link a new user to their referrer. Single-tier only — the referee's direct
 * referrer earns points on the referee's volume. The `referral_tier` enum still
 * carries "t2" for back-compat, but no T2 rows are created.
 */
export async function linkReferral(refereeId: string, referralCode: string) {
  const referrer = await db.query.users.findFirst({
    where: eq(users.referralCode, referralCode),
  });
  if (!referrer || referrer.id === refereeId) return;

  const existing = await db.query.referrals.findFirst({
    where: and(eq(referrals.refereeId, refereeId), eq(referrals.tier, "t1")),
  });
  if (existing) return;

  await db.insert(referrals).values({
    id: crypto.randomUUID(),
    referrerId: referrer.id,
    refereeId,
    tier: "t1",
  });
}

export interface ReferralStats {
  referralCount: number;
  points: number;
  /** 1-based rank among referrers with > 0 points; null if user has no points. */
  rank: number | null;
  totalReferrers: number;
}

export async function getReferralStats(userId: string): Promise<ReferralStats> {
  const rows = await db.query.referrals.findMany({
    where: eq(referrals.referrerId, userId),
  });
  const referralCount = rows.filter((r) => r.tier === "t1").length;
  const points = rows.reduce((sum, r) => sum + Number(r.points), 0);

  const ranked = await db
    .select({
      referrerId: referrals.referrerId,
      total: sql<string>`sum(${referrals.points})`,
    })
    .from(referrals)
    .groupBy(referrals.referrerId);

  const withPoints = ranked.filter((r) => Number(r.total) > 0);
  const higher = withPoints.filter((r) => Number(r.total) > points).length;

  return {
    referralCount,
    points,
    rank: points > 0 ? higher + 1 : null,
    totalReferrers: withPoints.length,
  };
}

/**
 * Award referral points to the referee's direct referrer.
 * 1 point per $1 of referred trading volume (taker notional). No cash payout.
 */
export async function accrueReferralPoints(refereeId: string, notionalUsdc: number) {
  if (!(notionalUsdc > 0)) return;
  await db
    .update(referrals)
    .set({
      points: sql`${referrals.points}::numeric + ${notionalUsdc.toFixed(6)}`,
      updatedAt: new Date(),
    })
    .where(and(eq(referrals.refereeId, refereeId), eq(referrals.tier, "t1")));
}
