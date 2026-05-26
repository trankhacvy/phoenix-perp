import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import WebSocket from "ws";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { users, walletMonitors } from "../db/schema/index.js";
import { alertQueue } from "../jobs/queues.js";
import { MONITOR_EVENTS_CHANNEL } from "../lib/constants.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { accrueReferralFee } from "../services/referral.js";
import type { TraderStateEvent } from "../types/index.js";
import {
  clearPeak,
  evaluateGuardianRules,
  evaluateMonitorAlerts,
  evaluatePositionFlip,
  evaluateRiskTier,
  startPriceAlertWatcher,
  stopPriceAlertWatcher,
} from "./evaluators/index.js";

type MonitorEvent =
  | { action: "subscribe"; wallet: string; telegramId: string }
  | { action: "unsubscribe"; wallet: string; telegramId: string };

const connections = new Map<string, WebSocket>();
const reconnecting = new Set<string>();
const reconnectFailures = new Map<string, number>();
const MAX_RECONNECT_FAILURES = 3;
const MAX_WS_CONNECTIONS = 500;
let shuttingDown = false;

const watcherIndex = new Map<string, Set<string>>();
const ownerMap = new Map<string, string>();
const ownerUserIdCache = new Map<string, string>();

function addWatcher(walletAddress: string, telegramId: string) {
  let set = watcherIndex.get(walletAddress);
  if (!set) {
    set = new Set();
    watcherIndex.set(walletAddress, set);
  }
  set.add(telegramId);
}

async function ensureConnection(walletAddress: string) {
  if (connections.has(walletAddress)) return;

  if (connections.size >= MAX_WS_CONNECTIONS) {
    logger.warn(
      { walletAddress, current: connections.size },
      "WS connection cap reached — skipping subscription",
    );
    return;
  }

  const ws = new WebSocket(config.PHOENIX_WS_URL);
  connections.set(walletAddress, ws);

  ws.on("open", () => {
    reconnectFailures.delete(walletAddress);
    ws.send(
      JSON.stringify({
        type: "subscribe",
        subscription: { channel: "traderState", wallet: walletAddress },
      }),
    );
    logger.info({ walletAddress }, "WS subscribed: traderState");
  });

  ws.on("message", async (raw) => {
    try {
      const event = JSON.parse(raw.toString()) as TraderStateEvent;
      await handleTraderStateEvent(walletAddress, event);
    } catch (err) {
      logger.error({ err, walletAddress }, "WS message parse error");
    }
  });

  ws.on("close", () => {
    connections.delete(walletAddress);
    logger.info({ walletAddress }, "WS closed");

    if (shuttingDown || reconnecting.has(walletAddress)) return;
    reconnecting.add(walletAddress);

    const failures = reconnectFailures.get(walletAddress) ?? 0;
    const baseDelay = Math.min(5000 * 2 ** failures, 60_000);
    const jitter = Math.random() * baseDelay * 0.5;
    const delay = baseDelay + jitter;

    setTimeout(() => {
      reconnecting.delete(walletAddress);
      if (shuttingDown) return;
      const hasWatchers =
        (watcherIndex.get(walletAddress)?.size ?? 0) > 0 || ownerMap.has(walletAddress);
      if (hasWatchers) {
        ensureConnection(walletAddress).catch((err) =>
          logger.error({ err, walletAddress }, "WS reconnect failed"),
        );
      }
    }, delay);
  });

  ws.on("error", (err) => {
    logger.error({ err, walletAddress }, "WS error");
    const failures = (reconnectFailures.get(walletAddress) ?? 0) + 1;
    reconnectFailures.set(walletAddress, failures);

    if (failures >= MAX_RECONNECT_FAILURES) {
      reconnectFailures.delete(walletAddress);
      const ownerTid = ownerMap.get(walletAddress);
      if (ownerTid) {
        alertQueue
          .add("ws-error", {
            telegramId: ownerTid,
            type: "ws_error",
            symbol: undefined,
            message:
              "⚠️ <b>Live alerts interrupted</b>\n\nLost connection to market feed. Reconnecting…",
            keyboard: [[{ text: "📊 Check positions", callback_data: "nav:positions" }]],
          })
          .catch(() => undefined);
      }
    }
  });
}

async function handleTraderStateEvent(walletAddress: string, event: TraderStateEvent) {
  const ownerTid = ownerMap.get(walletAddress);
  const watchers = watcherIndex.get(walletAddress) ?? new Set<string>();

  const prevKey = `ws:positions:${walletAddress}`;
  const prevRaw = await redis.get(prevKey);
  const prevPositions = prevRaw ? (JSON.parse(prevRaw) as TraderStateEvent["positions"]) : null;

  if (ownerTid) {
    const userId = (await getOwnerUserId(walletAddress)) ?? ownerTid;

    await evaluatePositionFlip(walletAddress, ownerTid, userId, event, prevPositions);
    await evaluateRiskTier(walletAddress, ownerTid, userId, event);
    await evaluateGuardianRules({ userId, telegramId: ownerTid, walletAddress, event });

    if (prevPositions) {
      for (const prevPos of prevPositions) {
        const still = (event.positions ?? []).find((p) => p.symbol === prevPos.symbol);
        if (!still) await clearPeak(userId, prevPos.symbol);
      }
    }

    if (config.REFERRAL_ENABLED) {
      for (const fill of event.fills ?? []) {
        const ownerId = await getOwnerUserId(walletAddress);
        if (ownerId) {
          const notional = Number(fill.size) * Number(fill.price);
          await accrueReferralFee(ownerId, notional).catch((err) =>
            logger.error({ err }, "Referral fee accrual failed"),
          );
        }
      }
    }
  }

  const externalWatchers = [...watchers].filter((tid) => tid !== ownerTid);
  if (externalWatchers.length > 0) {
    await evaluateMonitorAlerts(walletAddress, externalWatchers, event, prevPositions);
  }

  await redis.set(prevKey, JSON.stringify(event.positions ?? []), "EX", 3600);
}

export async function subscribeUser(walletAddress: string, telegramId: string) {
  ownerMap.set(walletAddress, telegramId);
  addWatcher(walletAddress, telegramId);
  await ensureConnection(walletAddress);
}

export async function subscribeMonitored(watchedWallet: string, telegramId: string) {
  addWatcher(watchedWallet, telegramId);
  await ensureConnection(watchedWallet);
}

export function unsubscribeMonitored(watchedWallet: string, telegramId: string) {
  const watchers = watcherIndex.get(watchedWallet);
  if (!watchers) return;
  watchers.delete(telegramId);

  if (watchers.size === 0 && !ownerMap.has(watchedWallet)) {
    const ws = connections.get(watchedWallet);
    ws?.close();
    connections.delete(watchedWallet);
    watcherIndex.delete(watchedWallet);
  }
}

export function unsubscribeUser(walletAddress: string) {
  const tid = ownerMap.get(walletAddress);
  ownerMap.delete(walletAddress);
  ownerUserIdCache.delete(walletAddress);

  const watchers = watcherIndex.get(walletAddress);
  if (tid && watchers) watchers.delete(tid);

  if (!watchers || watchers.size === 0) {
    const ws = connections.get(walletAddress);
    ws?.close();
    connections.delete(walletAddress);
    watcherIndex.delete(walletAddress);
  }
}

const OWNER_CACHE_MAX = 5000;

async function getOwnerUserId(walletAddress: string): Promise<string | null> {
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

export async function startWsManager() {
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
  startPriceAlertWatcher();
}

export function stopWsManager() {
  shuttingDown = true;
  for (const [, ws] of connections) ws.close();
  stopPriceAlertWatcher();
  if (monitorSub) monitorSub.disconnect();
}

export function getWsStats() {
  return {
    connections: connections.size,
    maxConnections: MAX_WS_CONNECTIONS,
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
