import { index, integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

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
  },
  (t) => [
    index("lb_portfolio_value_idx").on(t.portfolioValue),
    index("lb_realized_pnl_idx").on(t.realizedPnl),
    index("lb_updated_at_idx").on(t.updatedAt),
  ],
);

export type LeaderboardSnapshot = typeof leaderboardSnapshots.$inferSelect;
export type NewLeaderboardSnapshot = typeof leaderboardSnapshots.$inferInsert;
