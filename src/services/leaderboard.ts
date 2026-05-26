import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import {
  type WalletMetadata,
  leaderboardSnapshots,
} from "../db/schema/leaderboard.js";
import { users } from "../db/schema/users.js";
import { logger } from "../lib/logger.js";
import { withRetry } from "../lib/retry.js";
import { getPhoenixClient } from "./phoenix/client.js";
import {
  type WalletAnalytics,
  computeWalletAnalytics,
  fetchAllTradeHistory,
} from "./phoenix/position.js";

const PHOENIX_PROGRAM_ID = new PublicKey(
  "EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih",
);

const TRADER_DISCRIMINANT = Buffer.from([41, 97, 73, 105, 110, 214, 112, 9]);

const DATA_SLICE_OFFSET = 8;
const DATA_SLICE_LENGTH = 148;

const QUOTE_LOT_DECIMALS = 1_000_000;

export interface GpaTrader {
  walletAddress: string;
  quoteLotCollateral: bigint;
  numMarkets: number;
  traderPdaIndex: number;
  subaccountIndex: number;
  lastUpdateSlot: bigint;
}

export async function discoverTraderWallets(): Promise<GpaTrader[]> {
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
        dataSlice: { offset: DATA_SLICE_OFFSET, length: DATA_SLICE_LENGTH },
      }),
    { attempts: 3, baseDelayMs: 2000 },
  );

  const agg = new Map<
    string,
    { quoteLotCollateral: bigint; numMarkets: number; lastUpdateSlot: bigint }
  >();

  for (const { account } of accounts) {
    const buf = account.data;
    const lastUpdateSlot = buf.readBigUInt64LE(8);
    const authority = new PublicKey(buf.subarray(48, 80));
    const quoteLotCollateral = buf.readBigInt64LE(80);
    const numMarkets = buf.readUInt16LE(144);

    const wallet = authority.toBase58();
    const existing = agg.get(wallet);
    if (existing) {
      existing.quoteLotCollateral += quoteLotCollateral;
      existing.numMarkets += numMarkets;
      if (lastUpdateSlot > existing.lastUpdateSlot) {
        existing.lastUpdateSlot = lastUpdateSlot;
      }
    } else {
      agg.set(wallet, { quoteLotCollateral, numMarkets, lastUpdateSlot });
    }
  }

  const traders: GpaTrader[] = [];
  for (const [wallet, data] of agg) {
    traders.push({
      walletAddress: wallet,
      quoteLotCollateral: data.quoteLotCollateral,
      numMarkets: data.numMarkets,
      traderPdaIndex: 0,
      subaccountIndex: 0,
      lastUpdateSlot: data.lastUpdateSlot,
    });
  }

  logger.info(
    { total: traders.length, raw: accounts.length },
    "GPA discovered trader wallets",
  );
  return traders;
}

export async function seedFromGpa(traders: GpaTrader[]): Promise<number> {
  const active = traders.filter(
    (t) => t.quoteLotCollateral > 0n || t.numMarkets > 0,
  );

  let inserted = 0;
  console.log(
    `Seeding ${active.length} active traders into the leaderboard...`,
  );
  for (const t of active) {
    const collateralUsd = (
      Number(t.quoteLotCollateral) / QUOTE_LOT_DECIMALS
    ).toFixed(6);

    const result = await db
      .insert(leaderboardSnapshots)
      .values({
        walletAddress: t.walletAddress,
        collateralBalance: collateralUsd,
        portfolioValue: collateralUsd,
        positionCount: t.numMarkets,
        discoveredVia: "gpa",
      })
      .onConflictDoNothing({ target: leaderboardSnapshots.walletAddress })
      .returning({ id: leaderboardSnapshots.id });

    if (result.length > 0) inserted++;
  }
  console.log(`Inserted ${inserted} traders from GPA seed`);
  logger.info({ active: active.length, inserted }, "GPA seed complete");
  return inserted;
}

export async function discoverBotUserWallets(): Promise<Set<string>> {
  const rows = await db
    .select({ walletAddress: users.walletAddress })
    .from(users)
    .where(eq(users.phoenixActivated, true));

  return new Set(rows.map((r) => r.walletAddress));
}

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

async function hydrateTrader(
  walletAddress: string,
): Promise<HydratedTrader | null> {
  try {
    const res = await withRetry(
      () => getPhoenixClient().api.traders().getTraderState(walletAddress),
      {
        attempts: 2,
        baseDelayMs: 2000,
        retryIf: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/429|rate.?limit/i.test(msg)) return false;
          return /network|ECONNRESET|timeout|ETIMEDOUT|fetch failed/i.test(msg);
        },
      },
    );

    const traders = res.traders ?? [];
    if (traders.length === 0) return null;

    const crossAccount =
      traders.find((t) => t.traderSubaccountIndex === 0) ?? traders[0];

    const totalUnrealizedPnl = traders
      .reduce((sum, t) => sum + Number(t.unrealizedPnl.ui), 0)
      .toFixed(6);
    const totalFunding = traders
      .reduce((sum, t) => sum + Number(t.accumulatedFunding.ui), 0)
      .toFixed(6);
    const totalPortfolioValue = traders
      .reduce((sum, t) => sum + Number(t.portfolioValue.ui), 0)
      .toFixed(6);
    const totalPositions = traders.reduce(
      (sum, t) => sum + (t.positions?.length ?? 0),
      0,
    );

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
    logger.warn({ walletAddress, err }, "Failed to hydrate trader");
    return null;
  }
}

async function hydrateTradeHistory(
  walletAddress: string,
): Promise<WalletAnalytics | null> {
  try {
    const trades = await fetchAllTradeHistory(walletAddress, 200);
    if (trades.length === 0) return null;
    return computeWalletAnalytics(trades);
  } catch {
    return null;
  }
}

const HYDRATE_DELAY_MS = 500;

export async function hydrateTradersBatch(
  wallets: string[],
  concurrency = 2,
  includeHistory = false,
): Promise<number> {
  let upserted = 0;
  let rateLimited = 0;
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

      const now = new Date();

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
          updatedAt: now,
          lastHydratedAt: now,
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
            updatedAt: now,
            lastHydratedAt: now,
            ...historyFields,
          },
        });

      upserted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|rate.?limit/i.test(msg)) {
        rateLimited++;
        if (rateLimited >= 10) {
          queue.length = 0;
          logger.warn("Too many 429s, aborting remaining hydration");
        }
      } else {
        logger.warn(
          { wallet, err },
          "Failed to process trader for leaderboard",
        );
      }
    }
  }

  while (queue.length > 0 || inFlight.size > 0) {
    while (inFlight.size < concurrency && queue.length > 0) {
      const wallet = queue.shift() as string;
      const p = processOne(wallet).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
    if (queue.length > 0)
      await new Promise((r) => setTimeout(r, HYDRATE_DELAY_MS));
  }

  if (rateLimited > 0) {
    logger.warn(
      { rateLimited, upserted },
      "Hydration finished with rate-limit hits",
    );
  }

  return upserted;
}

const BACKFILL_STALE_MINUTES = 30;
const BACKFILL_BATCH_SIZE = 50;

export async function backfillStaleTraders(
  includeHistory: boolean,
): Promise<number> {
  const staleThreshold = new Date(Date.now() - BACKFILL_STALE_MINUTES * 60_000);

  const stale = await db
    .select({ walletAddress: leaderboardSnapshots.walletAddress })
    .from(leaderboardSnapshots)
    .where(
      and(
        sql`${leaderboardSnapshots.collateralBalance}::numeric != 0`,
        sql`(${leaderboardSnapshots.lastHydratedAt} IS NULL OR ${leaderboardSnapshots.lastHydratedAt} < ${staleThreshold})`,
      ),
    )
    .orderBy(asc(leaderboardSnapshots.lastHydratedAt))
    .limit(BACKFILL_BATCH_SIZE);

  if (stale.length === 0) return 0;

  const wallets = stale.map((r) => r.walletAddress);
  return hydrateTradersBatch(wallets, 2, includeHistory);
}

export async function upsertAndHydrateWallet(
  walletAddress: string,
): Promise<void> {
  await db
    .insert(leaderboardSnapshots)
    .values({ walletAddress, discoveredVia: "ws_trades" })
    .onConflictDoNothing({ target: leaderboardSnapshots.walletAddress });

  const trader = await hydrateTrader(walletAddress);
  if (!trader) return;

  const now = new Date();
  await db
    .update(leaderboardSnapshots)
    .set({
      collateralBalance: trader.collateralBalance,
      effectiveCollateral: trader.effectiveCollateral,
      unrealizedPnl: trader.unrealizedPnl,
      portfolioValue: trader.portfolioValue,
      accumulatedFunding: trader.accumulatedFunding,
      riskTier: trader.riskTier,
      positionCount: trader.positionCount,
      discoveredVia: "ws_trades",
      updatedAt: now,
      lastHydratedAt: now,
    })
    .where(eq(leaderboardSnapshots.walletAddress, walletAddress));
}

export async function syncWalletTags(): Promise<number> {
  const filePath = join(process.cwd(), "data", "wallet-tags.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    logger.info("No wallet-tags.json found, skipping metadata sync");
    return 0;
  }

  let tags: Record<string, WalletMetadata>;
  try {
    tags = JSON.parse(raw) as Record<string, WalletMetadata>;
  } catch (err) {
    logger.error({ err, filePath }, "wallet-tags.json has invalid JSON");
    return 0;
  }
  const entries = Object.entries(tags);
  let synced = 0;

  for (const [wallet, metadata] of entries) {
    await db
      .insert(leaderboardSnapshots)
      .values({ walletAddress: wallet, metadata })
      .onConflictDoUpdate({
        target: leaderboardSnapshots.walletAddress,
        set: { metadata },
      });
    synced++;
  }

  logger.info({ synced }, "Wallet tags synced");
  return synced;
}

export type LeaderboardSortBy = "total_volume" | "win_rate" | "realized_pnl";

export async function getLeaderboard(
  sortBy: LeaderboardSortBy = "total_volume",
  page = 0,
  pageSize = 10,
) {
  const where = sql`${leaderboardSnapshots.collateralBalance}::numeric != 0`;

  const orderExpr =
    sortBy === "win_rate"
      ? sql`COALESCE(${leaderboardSnapshots.winCount}::float / NULLIF(${leaderboardSnapshots.winCount} + ${leaderboardSnapshots.lossCount}, 0), 0)`
      : sortBy === "realized_pnl"
        ? sql`COALESCE(${leaderboardSnapshots.realizedPnl}::float, 0)`
        : sql`COALESCE(${leaderboardSnapshots.totalVolume}::float, 0)`;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(leaderboardSnapshots)
      .where(where)
      .orderBy(desc(orderExpr))
      .limit(pageSize)
      .offset(page * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leaderboardSnapshots)
      .where(where),
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
      lastUpdated: sql<
        string | null
      >`max(${leaderboardSnapshots.lastHydratedAt})::text`,
    })
    .from(leaderboardSnapshots);

  const raw = result[0];
  return {
    totalTraders: raw?.totalTraders ?? 0,
    lastUpdated: raw?.lastUpdated ? new Date(raw.lastUpdated) : null,
  };
}
