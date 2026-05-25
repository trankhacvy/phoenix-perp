import { index, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const trades = pgTable(
  "trades",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    walletAddress: text("wallet_address").notNull(),

    symbol: text("symbol").notNull(),
    side: text("side").notNull(), // 'long' | 'short'
    action: text("action").notNull(), // 'open' | 'close'

    marginUsdc: numeric("margin_usdc", { precision: 20, scale: 6 }),
    leverage: numeric("leverage", { precision: 10, scale: 2 }),
    notionalUsdc: numeric("notional_usdc", { precision: 20, scale: 6 }).notNull(),
    baseUnits: text("base_units").notNull(),

    markPrice: numeric("mark_price", { precision: 20, scale: 6 }).notNull(),
    feeUsdc: numeric("fee_usdc", { precision: 20, scale: 6 }),

    closeFraction: numeric("close_fraction", { precision: 5, scale: 4 }),

    txSignature: text("tx_signature"),
    status: text("status").notNull().default("confirmed"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("trades_user_idx").on(t.userId, t.createdAt),
    index("trades_symbol_idx").on(t.symbol, t.createdAt),
    index("trades_created_at_idx").on(t.createdAt),
  ],
);

export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
