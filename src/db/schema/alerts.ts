import { boolean, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const alertTypeEnum = pgEnum("alert_type", [
  "at_risk",
  "cancellable",
  "liquidatable",
  "fill",
  "tpsl_flip",
  "price",
  "funding_flip",
  "large_funding",
]);
// NOTE: fill, funding_flip, large_funding are deprecated but kept in the enum
// for backward compatibility with existing DB rows. They are no longer shown
// in the UI or checked by the WS worker.

export const alertSubscriptions = pgTable("alert_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: alertTypeEnum("type").notNull(),
  symbol: text("symbol"), // null = all markets
  triggerPrice: text("trigger_price"), // for price alerts only
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AlertSubscription = typeof alertSubscriptions.$inferSelect;
export type NewAlertSubscription = typeof alertSubscriptions.$inferInsert;
