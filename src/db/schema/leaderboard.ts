import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export interface WalletMetadata {
  name?: string;
  twitter?: string;
  avatar?: string;
  tags?: string[];
}

export const leaderboardSnapshots = pgTable(
  "leaderboard_snapshots",
  {
    id: serial("id").primaryKey(),
    walletAddress: text("wallet_address").notNull().unique(),
    collateralBalance: numeric("collateral_balance", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    effectiveCollateral: numeric("effective_collateral", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    unrealizedPnl: numeric("unrealized_pnl", { precision: 20, scale: 6 }).notNull().default("0"),
    portfolioValue: numeric("portfolio_value", { precision: 20, scale: 6 }).notNull().default("0"),
    accumulatedFunding: numeric("accumulated_funding", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    riskTier: text("risk_tier"),
    positionCount: integer("position_count").notNull().default(0),
    totalVolume: numeric("total_volume", { precision: 24, scale: 6 }),
    realizedPnl: numeric("realized_pnl", { precision: 20, scale: 6 }),
    winCount: integer("win_count"),
    lossCount: integer("loss_count"),
    totalTrades: integer("total_trades"),
    discoveredVia: text("discovered_via").notNull().default("gpa"),
    firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lastHydratedAt: timestamp("last_hydrated_at"),
    lastUpdateSlot: bigint("last_update_slot", { mode: "bigint" }),
    metadata: jsonb("metadata").$type<WalletMetadata>(),
  },
  (t) => [
    index("lb_portfolio_value_idx").on(t.portfolioValue),
    index("lb_realized_pnl_idx").on(t.realizedPnl),
    index("lb_updated_at_idx").on(t.updatedAt),
    index("lb_last_update_slot_idx").on(t.lastUpdateSlot),
  ],
);

export type LeaderboardSnapshot = typeof leaderboardSnapshots.$inferSelect;
export type NewLeaderboardSnapshot = typeof leaderboardSnapshots.$inferInsert;
