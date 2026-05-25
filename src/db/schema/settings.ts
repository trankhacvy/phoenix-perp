import { boolean, integer, numeric, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const feeModePgEnum = pgEnum("fee_mode", ["eco", "normal", "turbo", "custom"]);

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  slippageBps: integer("slippage_bps").default(50).notNull(),
  defaultLeverage: integer("default_leverage").default(5).notNull(),
  confirmTrades: boolean("confirm_trades").default(true).notNull(),
  confirmClose: boolean("confirm_close").default(true).notNull(),
  feeMode: feeModePgEnum("fee_mode").default("normal").notNull(),
  customFeeSol: numeric("custom_fee_sol", { precision: 12, scale: 9 }),
  autoTpPct: numeric("auto_tp_pct", { precision: 5, scale: 2 }),
  autoSlPct: numeric("auto_sl_pct", { precision: 5, scale: 2 }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserSettings = typeof userSettings.$inferSelect;
