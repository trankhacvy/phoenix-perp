import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  slippageBps: integer("slippage_bps").default(50).notNull(),
  defaultLeverage: integer("default_leverage").default(5).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserSettings = typeof userSettings.$inferSelect;
