import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { referrals, users } from "../db/schema/index.js";

const T1_RATIO = 0.2;
const T2_RATIO = 0.1;

export function generateReferralCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

export async function linkReferral(refereeId: string, referralCode: string) {
  const referrer = await db.query.users.findFirst({
    where: eq(users.referralCode, referralCode),
  });
  if (!referrer || referrer.id === refereeId) return;

  const existingT1 = await db.query.referrals.findFirst({
    where: and(eq(referrals.refereeId, refereeId), eq(referrals.tier, "t1")),
  });
  if (existingT1) return;

  await db.insert(referrals).values({
    id: crypto.randomUUID(),
    referrerId: referrer.id,
    refereeId,
    tier: "t1",
  });

  const referrerRecord = await db.query.referrals.findFirst({
    where: and(eq(referrals.refereeId, referrer.id), eq(referrals.tier, "t1")),
  });
  if (referrerRecord) {
    const existingT2 = await db.query.referrals.findFirst({
      where: and(eq(referrals.refereeId, refereeId), eq(referrals.tier, "t2")),
    });
    if (!existingT2) {
      await db.insert(referrals).values({
        id: crypto.randomUUID(),
        referrerId: referrerRecord.referrerId,
        refereeId,
        tier: "t2",
      });
    }
  }
}

export async function getReferralStats(userId: string) {
  const rows = await db.query.referrals.findMany({
    where: eq(referrals.referrerId, userId),
  });

  const t1 = rows.filter((r) => r.tier === "t1");
  const t2 = rows.filter((r) => r.tier === "t2");
  const totalAccrued = rows.reduce((sum, r) => sum + Number(r.accruedUsdc), 0);
  const totalClaimed = rows.reduce((sum, r) => sum + Number(r.claimedUsdc), 0);

  return {
    t1Count: t1.length,
    t2Count: t2.length,
    totalAccruedUsdc: totalAccrued,
    claimableUsdc: totalAccrued - totalClaimed,
  };
}

export async function accrueReferralFee(userId: string, notionalUsdc: number) {
  const builderFeeUsdc = (notionalUsdc * config.BUILDER_FEE_BPS) / 10000;

  const t1Fee = builderFeeUsdc * T1_RATIO;
  await db
    .update(referrals)
    .set({
      accruedUsdc: sql`${referrals.accruedUsdc}::numeric + ${t1Fee.toFixed(6)}`,
      updatedAt: new Date(),
    })
    .where(and(eq(referrals.refereeId, userId), eq(referrals.tier, "t1")));

  const t2Fee = builderFeeUsdc * T2_RATIO;
  await db
    .update(referrals)
    .set({
      accruedUsdc: sql`${referrals.accruedUsdc}::numeric + ${t2Fee.toFixed(6)}`,
      updatedAt: new Date(),
    })
    .where(and(eq(referrals.refereeId, userId), eq(referrals.tier, "t2")));
}

export async function getClaimableReferrals(userId: string) {
  return db.query.referrals.findMany({
    where: and(eq(referrals.referrerId, userId), gt(referrals.accruedUsdc, "0")),
  });
}
