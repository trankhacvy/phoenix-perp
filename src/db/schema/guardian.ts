import { boolean, integer, numeric, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const guardianRuleTypeEnum = pgEnum("guardian_rule_type", [
  "liq_distance",
  "drawdown",
  "pnl_target",
  "funding_drain",
  "exposure_limit",
  "margin_ratio",
  "trailing_stop",
  "breakeven",
]);

export const guardianActionEnum = pgEnum("guardian_action", [
  "notify",
  "suggest",
  "auto_close",
  "auto_reduce",
  "auto_margin",
]);

export const guardianRules = pgTable("guardian_rules", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  ruleType: guardianRuleTypeEnum("rule_type").notNull(),
  symbol: text("symbol"),
  side: text("side"),
  threshold: numeric("threshold", { precision: 12, scale: 4 }).notNull(),
  direction: text("direction").notNull(),
  action: guardianActionEnum("action").notNull().default("suggest"),
  actionParam: numeric("action_param", { precision: 12, scale: 4 }),
  enabled: boolean("enabled").default(true).notNull(),
  cooldownSec: integer("cooldown_sec").default(300).notNull(),
  lastTriggeredAt: timestamp("last_triggered_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type GuardianRule = typeof guardianRules.$inferSelect;
export type NewGuardianRule = typeof guardianRules.$inferInsert;
