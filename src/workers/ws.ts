import type { TraderStateTradeHistoryDelta, TraderStateUpdate } from "@ellipsis-labs/rise";
import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { solscanUrl } from "../bot/lib/fmt.js";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { users, walletMonitors } from "../db/schema/index.js";
import { type AlertButton, alertQueue } from "../jobs/queues.js";
import { MONITOR_EVENTS_CHANNEL } from "../lib/constants.js";
import { logger } from "../lib/logger.js";
import { getPhoenixWsClient } from "../services/phoenix/client.js";
import { getMarket } from "../services/phoenix/market.js";
import { accrueReferralFee } from "../services/referral.js";
import type { AccountSnapshot, CachedPosition } from "../types/index.js";
import { clearPeak } from "./evaluators/guardian.js";
import { emitMonitorFills, evaluateMonitorAlerts } from "./evaluators/monitor.js";
import { evaluatePositionFlip } from "./evaluators/position-flip.js";
import { markRestDirty } from "./rest-refresh.js";
import { fillNotional, isLiquidation, mergeTraderState } from "./trader-state-merge.js";

type MonitorEvent =
  | { action: "subscribe"; wallet: string; telegramId: string }
  | { action: "unsubscribe"; wallet: string; telegramId: string };

const controllers = new Map<string, AbortController>();
const snapshots = new Map<string, AccountSnapshot>();
let shuttingDown = false;

const watcherIndex = new Map<string, Set<string>>();
const ownerMap = new Map<string, string>();
const ownerUserIdCache = new Map<string, string>();
const OWNER_CACHE_MAX = 5000;

export function getSnapshot(walletAddress: string): AccountSnapshot | undefined {
  return snapshots.get(walletAddress);
}

export function getActiveWallets(): string[] {
  return [...snapshots.keys()];
}

export function getOwners(): { walletAddress: string; telegramId: string }[] {
  return [...ownerMap.entries()].map(([walletAddress, telegramId]) => ({
    walletAddress,
    telegramId,
  }));
}

function addWatcher(walletAddress: string, telegramId: string) {
  let set = watcherIndex.get(walletAddress);
  if (!set) {
    set = new Set();
    watcherIndex.set(walletAddress, set);
  }
  set.add(telegramId);
}

export async function getOwnerUserId(walletAddress: string): Promise<string | null> {
  const cached = ownerUserIdCache.get(walletAddress);
  if (cached) return cached;
  const user = await db.query.users.findFirst({
    where: eq(users.walletAddress, walletAddress),
  });
  if (user) {
    if (ownerUserIdCache.size >= OWNER_CACHE_MAX) {
      const oldest = ownerUserIdCache.keys().next().value as string;
      ownerUserIdCache.delete(oldest);
    }
    ownerUserIdCache.set(walletAddress, user.id);
  }
  return user?.id ?? null;
}

async function resolveDecimals(symbol: string): Promise<number | null> {
  const market = await getMarket(symbol).catch(() => null);
  return market ? market.baseLotsDecimals : null;
}

async function applyTraderState(walletAddress: string, update: TraderStateUpdate): Promise<void> {
  const prev = snapshots.get(walletAddress);
  const prevPositions = prev?.positions ?? null;

  const next = await mergeTraderState(prev ?? null, update, resolveDecimals);
  next.walletAddress = walletAddress;
  snapshots.set(walletAddress, next);

  if (update.messageType === "delta") {
    const fills = update.deltas.flatMap((d) => d.tradeHistory ?? []);
    if (fills.length > 0) await onFills(walletAddress, fills);
  }

  markRestDirty(walletAddress);
  await runStructuralEvaluators(walletAddress, next.positions, prevPositions);
}

async function runStructuralEvaluators(
  walletAddress: string,
  positions: CachedPosition[],
  prevPositions: CachedPosition[] | null,
) {
  const ownerTid = ownerMap.get(walletAddress);
  const watchers = watcherIndex.get(walletAddress) ?? new Set<string>();

  if (ownerTid) {
    const userId = (await getOwnerUserId(walletAddress)) ?? ownerTid;
    await evaluatePositionFlip(ownerTid, userId, positions, prevPositions);
    if (prevPositions) {
      for (const prev of prevPositions) {
        if (!positions.find((p) => p.symbol === prev.symbol)) await clearPeak(userId, prev.symbol);
      }
    }
  }

  const externalWatchers = [...watchers].filter((tid) => tid !== ownerTid);
  if (externalWatchers.length > 0) {
    await evaluateMonitorAlerts(walletAddress, externalWatchers, positions, prevPositions);
  }
}

async function onFills(
  walletAddress: string,
  fills: TraderStateTradeHistoryDelta[],
): Promise<void> {
  const ownerTid = ownerMap.get(walletAddress);
  const watchers = watcherIndex.get(walletAddress) ?? new Set<string>();

  if (ownerTid) {
    if (config.REFERRAL_ENABLED) {
      const ownerId = await getOwnerUserId(walletAddress);
      if (ownerId) {
        for (const fill of fills) {
          await accrueReferralFee(ownerId, fillNotional(fill)).catch((err) =>
            logger.error({ err }, "Referral fee accrual failed"),
          );
        }
      }
    }

    const liquidations = fills.filter(isLiquidation);
    if (liquidations.length > 0) await queueLiquidationAlert(ownerTid, liquidations);
  }

  const externalWatchers = [...watchers].filter((tid) => tid !== ownerTid);
  if (externalWatchers.length > 0) emitMonitorFills(walletAddress, externalWatchers, fills);
}

async function queueLiquidationAlert(
  telegramId: string,
  liquidations: TraderStateTradeHistoryDelta[],
): Promise<void> {
  const rows = liquidations.map(
    (f) =>
      fmt`${FormattedString.b(f.market)}  ${f.size} @ ${FormattedString.b(`$${Number(f.price).toFixed(4)}`)}`,
  );
  const header = fmt`🆘 ${FormattedString.b("Position liquidated")}`;
  const sig = liquidations[0].signature;
  const body = FormattedString.join([header, ...rows], "\n");
  const full = sig
    ? FormattedString.join(
        [body, fmt`${FormattedString.link("View on Solscan →", solscanUrl(sig))}`],
        "\n\n",
      )
    : body;
  const keyboard: AlertButton[][] = [[{ text: "📊 Positions", callback_data: "nav:positions" }]];
  await alertQueue.add("liquidation", {
    telegramId,
    type: "liquidatable",
    symbol: liquidations[0].market,
    message: full.text,
    entities: full.entities,
    keyboard,
  });
}

function subscribeTrader(walletAddress: string) {
  if (controllers.has(walletAddress) || shuttingDown) return;
  const controller = new AbortController();
  controllers.set(walletAddress, controller);

  void (async () => {
    for await (const update of getPhoenixWsClient().traderState(
      walletAddress,
      0,
      controller.signal,
    )) {
      await applyTraderState(walletAddress, update);
    }
  })().catch((err) => {
    if (err instanceof Error && err.name === "AbortError") return;
    logger.error({ err, walletAddress }, "traderState subscription failed");
  });
}

function unsubscribeTrader(walletAddress: string) {
  controllers.get(walletAddress)?.abort();
  controllers.delete(walletAddress);
  snapshots.delete(walletAddress);
}

export async function subscribeUser(walletAddress: string, telegramId: string) {
  ownerMap.set(walletAddress, telegramId);
  addWatcher(walletAddress, telegramId);
  subscribeTrader(walletAddress);
}

export async function subscribeMonitored(watchedWallet: string, telegramId: string) {
  addWatcher(watchedWallet, telegramId);
  subscribeTrader(watchedWallet);
}

export function unsubscribeMonitored(watchedWallet: string, telegramId: string) {
  const watchers = watcherIndex.get(watchedWallet);
  if (!watchers) return;
  watchers.delete(telegramId);

  if (watchers.size === 0 && !ownerMap.has(watchedWallet)) {
    watcherIndex.delete(watchedWallet);
    unsubscribeTrader(watchedWallet);
  }
}

export function unsubscribeUser(walletAddress: string) {
  const tid = ownerMap.get(walletAddress);
  ownerMap.delete(walletAddress);
  ownerUserIdCache.delete(walletAddress);

  const watchers = watcherIndex.get(walletAddress);
  if (tid && watchers) watchers.delete(tid);

  if (!watchers || watchers.size === 0) {
    watcherIndex.delete(walletAddress);
    unsubscribeTrader(walletAddress);
  }
}

export async function startWsManager() {
  shuttingDown = false;
  const ownWallets = await db
    .select({ walletAddress: users.walletAddress, telegramId: users.telegramId })
    .from(users);

  for (const user of ownWallets) {
    await subscribeUser(user.walletAddress, user.telegramId);
  }

  const monitors = await db
    .select({
      watchedWallet: walletMonitors.watchedWallet,
      telegramId: users.telegramId,
    })
    .from(walletMonitors)
    .innerJoin(users, eq(walletMonitors.userId, users.id))
    .where(eq(walletMonitors.enabled, true));

  for (const m of monitors) {
    await subscribeMonitored(m.watchedWallet, m.telegramId);
  }

  logger.info({ ownWallets: ownWallets.length, monitors: monitors.length }, "WS manager started");

  subscribeMonitorEvents();
}

export function stopWsManager() {
  shuttingDown = true;
  for (const [, controller] of controllers) controller.abort();
  controllers.clear();
  if (monitorSub) monitorSub.disconnect();
}

export function getWsStats() {
  return {
    subscriptions: controllers.size,
    owners: ownerMap.size,
    watchers: watcherIndex.size,
  };
}

let monitorSub: Redis | null = null;

function subscribeMonitorEvents() {
  const sub = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  sub.subscribe(MONITOR_EVENTS_CHANNEL, (err) => {
    if (err) logger.error({ err }, "monitor:events subscribe error");
    else logger.info("Subscribed to monitor:events");
  });

  sub.on("message", (_channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as MonitorEvent;
      if (event.action === "subscribe") {
        subscribeMonitored(event.wallet, event.telegramId).catch((err) =>
          logger.error({ err }, "subscribeMonitored via pub/sub failed"),
        );
      } else if (event.action === "unsubscribe") {
        unsubscribeMonitored(event.wallet, event.telegramId);
      }
    } catch (err) {
      logger.error({ err }, "monitor:events parse error");
    }
  });

  sub.on("error", (err: Error) => logger.error({ err }, "monitor:events Redis error"));

  monitorSub = sub;
}
