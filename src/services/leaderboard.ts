import { Connection, PublicKey } from "@solana/web3.js";
import { desc, isNotNull, sql } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { leaderboardSnapshots } from "../db/schema/leaderboard.js";
import { logger } from "../lib/logger.js";
import { withRetry } from "../lib/retry.js";
import { getPhoenixClient } from "./phoenix/client.js";
import {
  type WalletAnalytics,
  computeWalletAnalytics,
  fetchAllTradeHistory,
} from "./phoenix/position.js";

const PHOENIX_PROGRAM_ID = new PublicKey("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");

// SHA-256("account:trader") first 8 bytes
const TRADER_DISCRIMINANT = Buffer.from([41, 97, 73, 105, 110, 214, 112, 9]);

// Authority pubkey starts at byte 56 in the Trader account layout
const AUTHORITY_OFFSET = 56;
const PUBKEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// GPA: Discover all trader wallet addresses on-chain
// ---------------------------------------------------------------------------

export async function discoverTraderWallets(): Promise<Set<string>> {
  const connection = new Connection(config.HELIUS_RPC_URL, "confirmed");

  const accounts = await withRetry(
    () =>
      connection.getProgramAccounts(PHOENIX_PROGRAM_ID, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: TRADER_DISCRIMINANT.toString("base64"),
              encoding: "base64",
            },
          },
        ],
        dataSlice: { offset: AUTHORITY_OFFSET, length: PUBKEY_LENGTH },
      }),
    { attempts: 3, baseDelayMs: 2000 },
  );

  const wallets = new Set<string>();
  for (const { account } of accounts) {
    const authority = new PublicKey(account.data.subarray(0, PUBKEY_LENGTH));
    wallets.add(authority.toBase58());
  }

  logger.info({ count: wallets.size, raw: accounts.length }, "GPA discovered trader wallets");
  return wallets;
}

// ---------------------------------------------------------------------------
// REST: Hydrate a single trader's state from Phoenix API
// ---------------------------------------------------------------------------

interface HydratedTrader {
  walletAddress: string;
  collateralBalance: string;
  effectiveCollateral: string;
  unrealizedPnl: string;
  portfolioValue: string;
  accumulatedFunding: string;
  riskTier: string;
  positionCount: number;
}

async function hydrateTrader(walletAddress: string): Promise<HydratedTrader | null> {
  try {
    const res = await withRetry(
      () => getPhoenixClient().api.traders().getTraderState(walletAddress),
      { attempts: 2, baseDelayMs: 500 },
    );

    const traders = res.traders ?? [];
    if (traders.length === 0) return null;

    const crossAccount = traders.find((t) => t.traderSubaccountIndex === 0) ?? traders[0];

    const totalUnrealizedPnl = traders
      .reduce((sum, t) => sum + Number(t.unrealizedPnl.ui), 0)
      .toFixed(6);
    const totalFunding = traders
      .reduce((sum, t) => sum + Number(t.accumulatedFunding.ui), 0)
      .toFixed(6);
    const totalPortfolioValue = traders
      .reduce((sum, t) => sum + Number(t.portfolioValue.ui), 0)
      .toFixed(6);
    const totalPositions = traders.reduce((sum, t) => sum + (t.positions?.length ?? 0), 0);

    return {
      walletAddress,
      collateralBalance: crossAccount.collateralBalance.ui,
      effectiveCollateral: crossAccount.effectiveCollateral.ui,
      unrealizedPnl: totalUnrealizedPnl,
      portfolioValue: totalPortfolioValue,
      accumulatedFunding: totalFunding,
      riskTier: crossAccount.riskTier ?? "safe",
      positionCount: totalPositions,
    };
  } catch (err) {
    logger.debug({ walletAddress, err }, "Failed to hydrate trader");
    return null;
  }
}

// ---------------------------------------------------------------------------
// REST: Hydrate trade history analytics (heavier call)
// ---------------------------------------------------------------------------

async function hydrateTradeHistory(walletAddress: string): Promise<WalletAnalytics | null> {
  try {
    const trades = await fetchAllTradeHistory(walletAddress, 200);
    if (trades.length === 0) return null;
    return computeWalletAnalytics(trades);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Batch hydration with concurrency control
// ---------------------------------------------------------------------------

export async function hydrateTradersBatch(
  wallets: string[],
  concurrency = 5,
  includeHistory = false,
): Promise<number> {
  let upserted = 0;
  const queue = [...wallets];
  const inFlight = new Set<Promise<void>>();

  async function processOne(wallet: string) {
    try {
      const trader = await hydrateTrader(wallet);
      if (!trader) return;

      let historyFields: Record<string, string | number | null> = {};
      if (includeHistory) {
        const analytics = await hydrateTradeHistory(wallet);
        if (analytics) {
          historyFields = {
            totalVolume: analytics.totalVolume.toFixed(6),
            realizedPnl: analytics.realizedPnl.toFixed(6),
            winCount: analytics.wins,
            lossCount: analytics.closedTrades - analytics.wins,
            totalTrades: analytics.totalFills,
          };
        }
      }

      await db
        .insert(leaderboardSnapshots)
        .values({
          walletAddress: trader.walletAddress,
          collateralBalance: trader.collateralBalance,
          effectiveCollateral: trader.effectiveCollateral,
          unrealizedPnl: trader.unrealizedPnl,
          portfolioValue: trader.portfolioValue,
          accumulatedFunding: trader.accumulatedFunding,
          riskTier: trader.riskTier,
          positionCount: trader.positionCount,
          updatedAt: new Date(),
          ...historyFields,
        })
        .onConflictDoUpdate({
          target: leaderboardSnapshots.walletAddress,
          set: {
            collateralBalance: trader.collateralBalance,
            effectiveCollateral: trader.effectiveCollateral,
            unrealizedPnl: trader.unrealizedPnl,
            portfolioValue: trader.portfolioValue,
            accumulatedFunding: trader.accumulatedFunding,
            riskTier: trader.riskTier,
            positionCount: trader.positionCount,
            updatedAt: new Date(),
            ...historyFields,
          },
        });

      upserted++;
    } catch (err) {
      logger.warn({ wallet, err }, "Failed to process trader for leaderboard");
    }
  }

  while (queue.length > 0 || inFlight.size > 0) {
    while (inFlight.size < concurrency && queue.length > 0) {
      const wallet = queue.shift() as string;
      const p = processOne(wallet).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }

  return upserted;
}

// ---------------------------------------------------------------------------
// Upsert a single wallet discovered via WebSocket trades
// ---------------------------------------------------------------------------

export async function upsertDiscoveredWallet(walletAddress: string): Promise<void> {
  await db
    .insert(leaderboardSnapshots)
    .values({ walletAddress, discoveredVia: "ws_trades" })
    .onConflictDoNothing({ target: leaderboardSnapshots.walletAddress });
}

// ---------------------------------------------------------------------------
// Leaderboard queries
// ---------------------------------------------------------------------------

export type LeaderboardSortBy = "portfolio_value" | "realized_pnl" | "total_volume";

function sortColumn(sortBy: LeaderboardSortBy) {
  switch (sortBy) {
    case "realized_pnl":
      return leaderboardSnapshots.realizedPnl;
    case "total_volume":
      return leaderboardSnapshots.totalVolume;
    default:
      return leaderboardSnapshots.portfolioValue;
  }
}

export async function getLeaderboard(
  sortBy: LeaderboardSortBy = "portfolio_value",
  page = 0,
  pageSize = 10,
) {
  const col = sortColumn(sortBy);

  const where =
    sortBy === "portfolio_value"
      ? sql`${leaderboardSnapshots.portfolioValue} > '0'`
      : isNotNull(col);

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(leaderboardSnapshots)
      .where(where)
      .orderBy(desc(col))
      .limit(pageSize)
      .offset(page * pageSize),
    db.select({ count: sql<number>`count(*)::int` }).from(leaderboardSnapshots).where(where),
  ]);

  return {
    rows,
    total: countResult[0]?.count ?? 0,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil((countResult[0]?.count ?? 0) / pageSize)),
  };
}

export async function getLeaderboardStats() {
  const result = await db
    .select({
      totalTraders: sql<number>`count(*)::int`,
      lastUpdated: sql<string | null>`max(${leaderboardSnapshots.updatedAt})::text`,
    })
    .from(leaderboardSnapshots);

  const raw = result[0];
  return {
    totalTraders: raw?.totalTraders ?? 0,
    lastUpdated: raw?.lastUpdated ? new Date(raw.lastUpdated) : null,
  };
}
