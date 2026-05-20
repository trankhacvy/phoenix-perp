import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(), // telegram user_id as string
  telegramId: text("telegram_id").notNull().unique(),
  username: text("username"),
  firstName: text("first_name"),
  privyUserId: text("privy_user_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  phoenixActivated: boolean("phoenix_activated").default(false).notNull(),
  referralCode: text("referral_code").unique(), // bot-native referral code for this user
  referredBy: text("referred_by"), // referral code used at signup
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
