import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { type WalletMetadata, leaderboardSnapshots } from "../db/schema/leaderboard.js";
import { users } from "../db/schema/users.js";
import { logger } from "../lib/logger.js";
import type { TokenBucket } from "../lib/rate-limiter.js";
import { withRetry } from "../lib/retry.js";
import { getPhoenixClient } from "./phoenix/client.js";
import {
  type WalletAnalytics,
  computeWalletAnalytics,
  fetchAllTradeHistory,
} from "./phoenix/position.js";

const PHOENIX_PROGRAM_ID = new PublicKey("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");

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

  logger.info({ total: traders.length, raw: accounts.length }, "GPA discovered trader wallets");
  return traders;
}

export interface GpaSeedResult {
  inserted: number;
  updated: number;
  changedWallets: string[];
}

const SEED_BATCH_SIZE = 500;

export async function seedFromGpa(traders: GpaTrader[]): Promise<GpaSeedResult> {
  const active = traders.filter((t) => t.quoteLotCollateral > 0n || t.numMarkets > 0);

  const existing = await db
    .select({
      walletAddress: leaderboardSnapshots.walletAddress,
      lastUpdateSlot: leaderboardSnapshots.lastUpdateSlot,
    })
    .from(leaderboardSnapshots);

  const existingSlots = new Map(existing.map((r) => [r.walletAddress, r.lastUpdateSlot]));
  logger.info(
    { active: active.length, existingInDb: existing.length },
    "GPA seed: classifying traders",
  );

  // Classify into new vs changed vs unchanged
  const toInsert: {
    walletAddress: string;
    collateralUsd: string;
    positionCount: number;
    slot: bigint;
  }[] = [];
  const toUpdate: {
    walletAddress: string;
    collateralUsd: string;
    positionCount: number;
    slot: bigint;
  }[] = [];

  for (const t of active) {
    const collateralUsd = (Number(t.quoteLotCollateral) / QUOTE_LOT_DECIMALS).toFixed(6);
    const slot = t.lastUpdateSlot;
    const dbSlot = existingSlots.get(t.walletAddress);

    if (dbSlot === undefined) {
      toInsert.push({
        walletAddress: t.walletAddress,
        collateralUsd,
        positionCount: t.numMarkets,
        slot,
      });
    } else if (dbSlot === null || slot > dbSlot) {
      toUpdate.push({
        walletAddress: t.walletAddress,
        collateralUsd,
        positionCount: t.numMarkets,
        slot,
      });
    }
  }

  logger.info(
    {
      toInsert: toInsert.length,
      toUpdate: toUpdate.length,
      unchanged: active.length - toInsert.length - toUpdate.length,
    },
    "GPA seed: classification done, starting DB writes",
  );

  let inserted = 0;

  // Batch inserts
  for (let i = 0; i < toInsert.length; i += SEED_BATCH_SIZE) {
    const batch = toInsert.slice(i, i + SEED_BATCH_SIZE);
    const result = await db
      .insert(leaderboardSnapshots)
      .values(
        batch.map((r) => ({
          walletAddress: r.walletAddress,
          collateralBalance: r.collateralUsd,
          portfolioValue: r.collateralUsd,
          positionCount: r.positionCount,
          lastUpdateSlot: r.slot,
          discoveredVia: "gpa" as const,
        })),
      )
      .onConflictDoNothing({ target: leaderboardSnapshots.walletAddress })
      .returning({ id: leaderboardSnapshots.id });
    inserted += result.length;
    logger.debug(
      {
        batch: Math.floor(i / SEED_BATCH_SIZE) + 1,
        totalBatches: Math.ceil(toInsert.length / SEED_BATCH_SIZE),
        inserted,
      },
      "GPA seed: insert batch done",
    );
  }

  // Batch updates via single SQL for each chunk
  const now = new Date();
  for (let i = 0; i < toUpdate.length; i += SEED_BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + SEED_BATCH_SIZE);
    // Use a single upsert to batch-update changed rows
    await db
      .insert(leaderboardSnapshots)
      .values(
        batch.map((r) => ({
          walletAddress: r.walletAddress,
          collateralBalance: r.collateralUsd,
          portfolioValue: r.collateralUsd,
          positionCount: r.positionCount,
          lastUpdateSlot: r.slot,
          discoveredVia: "gpa" as const,
        })),
      )
      .onConflictDoUpdate({
        target: leaderboardSnapshots.walletAddress,
        set: {
          collateralBalance: sql`excluded.collateral_balance`,
          portfolioValue: sql`excluded.portfolio_value`,
          positionCount: sql`excluded.position_count`,
          lastUpdateSlot: sql`excluded.last_update_slot`,
          updatedAt: now,
        },
      });
    logger.debug(
      {
        batch: Math.floor(i / SEED_BATCH_SIZE) + 1,
        totalBatches: Math.ceil(toUpdate.length / SEED_BATCH_SIZE),
      },
      "GPA seed: update batch done",
    );
  }

  const changedWallets = [
    ...toInsert.map((r) => r.walletAddress),
    ...toUpdate.map((r) => r.walletAddress),
  ];

  logger.info(
    {
      active: active.length,
      inserted,
      updated: toUpdate.length,
      changed: changedWallets.length,
      skipped: active.length - toInsert.length - toUpdate.length,
    },
    "GPA seed complete",
  );
  return { inserted, updated: toUpdate.length, changedWallets };
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

async function hydrateTrader(walletAddress: string): Promise<HydratedTrader | null> {
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
    logger.warn({ walletAddress, err }, "Failed to hydrate trader");
    return null;
  }
}

async function hydrateTradeHistory(walletAddress: string): Promise<WalletAnalytics | null> {
  try {
    const trades = await fetchAllTradeHistory(walletAddress, 200);
    if (trades.length === 0) return null;
    return computeWalletAnalytics(trades);
  } catch {
    return null;
  }
}

export interface HydrateBatchOptions {
  concurrency?: number;
  includeHistory?: boolean;
  rateLimiter?: TokenBucket;
}

export async function hydrateTradersBatch(
  wallets: string[],
  opts: HydrateBatchOptions = {},
): Promise<number> {
  const { concurrency = 2, includeHistory = false, rateLimiter } = opts;

  logger.info(
    { total: wallets.length, concurrency, includeHistory, rateLimited: !!rateLimiter },
    "Hydration batch starting",
  );

  let upserted = 0;
  let failed = 0;
  let rateLimited = 0;
  let processed = 0;
  const queue = [...wallets];
  const inFlight = new Set<Promise<void>>();

  async function processOne(wallet: string) {
    try {
      if (rateLimiter) await rateLimiter.acquire();

      const trader = await hydrateTrader(wallet);
      if (!trader) return;

      let historyFields: Record<string, string | number | null> = {};
      if (includeHistory) {
        if (rateLimiter) await rateLimiter.acquire();
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
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      // biome-ignore lint/suspicious/noExplicitAny: Phoenix SDK error shape not typed
      const retryAfter = (err as any)?.retryAfterSeconds;
      if (/429|rate.?limit/i.test(msg)) {
        rateLimited++;
        const backoffSec = Math.max(retryAfter ?? 5, 5);
        logger.warn({ rateLimited, backoffSec, remaining: queue.length }, "Hit 429, backing off");
        await new Promise((r) => setTimeout(r, backoffSec * 1000));
        // Re-queue wallet so it gets retried after backoff
        queue.unshift(wallet);
        failed--;
        if (rateLimited >= 10) {
          queue.length = 0;
          logger.warn("Too many 429s, aborting remaining hydration");
        }
      } else {
        logger.warn({ wallet, err }, "Failed to process trader for leaderboard");
      }
    } finally {
      processed++;
      if (processed % 10 === 0 || processed === wallets.length) {
        logger.info(
          { processed, total: wallets.length, upserted, failed, remaining: queue.length },
          "Hydration progress",
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
  }

  if (rateLimited > 0) {
    logger.warn({ rateLimited, upserted }, "Hydration finished with rate-limit hits");
  }

  logger.info(
    { total: wallets.length, upserted, skipped: wallets.length - upserted },
    "Batch hydration done",
  );
  return upserted;
}

const BACKFILL_STALE_MINUTES = 30;
const BACKFILL_BATCH_SIZE = 50;

export async function backfillStaleTraders(
  includeHistory: boolean,
  rateLimiter?: TokenBucket,
): Promise<number> {
  const staleThreshold = new Date(Date.now() - BACKFILL_STALE_MINUTES * 60_000);

  // Prioritize traders with open positions — their data matters most
  const stale = await db
    .select({ walletAddress: leaderboardSnapshots.walletAddress })
    .from(leaderboardSnapshots)
    .where(
      and(
        sql`${leaderboardSnapshots.collateralBalance}::numeric != 0`,
        sql`(${leaderboardSnapshots.lastHydratedAt} IS NULL OR ${leaderboardSnapshots.lastHydratedAt} < ${staleThreshold})`,
      ),
    )
    .orderBy(desc(leaderboardSnapshots.positionCount), asc(leaderboardSnapshots.lastHydratedAt))
    .limit(BACKFILL_BATCH_SIZE);

  if (stale.length === 0) return 0;

  const wallets = stale.map((r) => r.walletAddress);
  return hydrateTradersBatch(wallets, { concurrency: 2, includeHistory, rateLimiter });
}

export async function upsertAndHydrateWallet(
  walletAddress: string,
  rateLimiter?: TokenBucket,
): Promise<void> {
  await db
    .insert(leaderboardSnapshots)
    .values({ walletAddress, discoveredVia: "ws_trades" })
    .onConflictDoNothing({ target: leaderboardSnapshots.walletAddress });

  if (rateLimiter) await rateLimiter.acquire();

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
      lastUpdated: sql<string | null>`max(${leaderboardSnapshots.lastHydratedAt})::text`,
    })
    .from(leaderboardSnapshots);

  const raw = result[0];
  return {
    totalTraders: raw?.totalTraders ?? 0,
    lastUpdated: raw?.lastUpdated ? new Date(raw.lastUpdated) : null,
  };
}
