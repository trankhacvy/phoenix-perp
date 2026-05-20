import { numeric, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const referralTierEnum = pgEnum("referral_tier", ["t1", "t2"]);

export const referrals = pgTable("referrals", {
  id: text("id").primaryKey(),
  referrerId: text("referrer_id")
    .notNull()
    .references(() => users.id),
  refereeId: text("referee_id")
    .notNull()
    .references(() => users.id),
  tier: referralTierEnum("tier").notNull(),
  // USDC accrued from builder fee rebate (operator-funded, not Phoenix native)
  accruedUsdc: numeric("accrued_usdc", { precision: 20, scale: 6 }).default("0").notNull(),
  claimedUsdc: numeric("claimed_usdc", { precision: 20, scale: 6 }).default("0").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
