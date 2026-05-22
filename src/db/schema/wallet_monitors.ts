import { boolean, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const walletMonitors = pgTable(
  "wallet_monitors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    watchedWallet: text("watched_wallet").notNull(),
    label: text("label"),
    alertOnFill: boolean("alert_on_fill").default(true).notNull(),
    alertOnPositionChange: boolean("alert_on_position_change").default(true).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("wallet_monitors_user_wallet_unique").on(t.userId, t.watchedWallet)],
);

export type WalletMonitor = typeof walletMonitors.$inferSelect;
export type NewWalletMonitor = typeof walletMonitors.$inferInsert;
