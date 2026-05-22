import { and, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import WebSocket from "ws";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { alertSubscriptions, users, walletMonitors } from "../db/schema/index.js";
import { alertQueue } from "../jobs/queues.js";
import { MONITOR_EVENTS_CHANNEL } from "../lib/constants.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { accrueReferralFee } from "../services/referral.js";
import type { RiskTier, TraderStateEvent } from "../types/index.js";

type MonitorEvent =
  | { action: "subscribe"; wallet: string; telegramId: string }
  | { action: "unsubscribe"; wallet: string; telegramId: string };

const connections = new Map<string, WebSocket>();
const reconnecting = new Set<string>();
const reconnectFailures = new Map<string, number>();
const MAX_RECONNECT_FAILURES = 3;

// wallet → Set of telegramIds that want alerts for this wallet (all watchers)
const watcherIndex = new Map<string, Set<string>>();

// wallet → ownerTelegramId (the bot user whose embedded wallet this is)
// Monitored-only wallets have no entry here.
const ownerMap = new Map<string, string>();

// wallet → userId (DB id, for referral accrual)
const ownerUserIdCache = new Map<string, string>();

const RISK_ALERT_TIERS: RiskTier[] = [
  "atRisk",
  "at_risk",
  "cancellable",
  "liquidatable",
  "backstopLiquidatable",
  "highRisk",
];

const TIER_MESSAGES: Record<string, string> = {
  atRisk: "⚠️ <b>Account At Risk</b>\nYour margin is below initial requirement.",
  at_risk: "⚠️ <b>Account At Risk</b>\nYour margin is below initial requirement.",
  cancellable: "🟠 <b>Orders May Be Cancelled</b>\nRisk-increasing orders can be force-cancelled.",
  liquidatable: "🔴 <b>Liquidation Warning</b>\nYour account can be liquidated now.",
  backstopLiquidatable: "🆘 <b>Backstop Liquidation</b>\nAccount beyond normal liquidation.",
  highRisk: "🆘 <b>High Risk — ADL Eligible</b>\nAccount deeply stressed.",
};

function buildRiskAlertMessage(event: TraderStateEvent): string | null {
  if (!RISK_ALERT_TIERS.includes(event.riskTier)) return null;
  return [
    TIER_MESSAGES[event.riskTier] ?? "",
    `Effective collateral: <code>${event.effectiveCollateral} USDC</code>`,
    `Risk score: <code>${event.riskScore}</code>`,
  ].join("\n");
}

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

    if (reconnecting.has(walletAddress)) return;
    reconnecting.add(walletAddress);
    setTimeout(() => {
      reconnecting.delete(walletAddress);
      const hasWatchers =
        (watcherIndex.get(walletAddress)?.size ?? 0) > 0 || ownerMap.has(walletAddress);
      if (hasWatchers) {
        ensureConnection(walletAddress).catch((err) =>
          logger.error({ err, walletAddress }, "WS reconnect failed"),
        );
      }
    }, 5000);
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
            type: "fill",
            symbol: undefined,
            message:
              "⚠️ <b>Live alerts interrupted</b>\n\nWe lost connection to the market feed. Reconnecting…\n\nUse /positions to check your account.",
          })
          .catch(() => undefined);
      }
    }
  });
}

async function handleTraderStateEvent(walletAddress: string, event: TraderStateEvent) {
  const ownerTid = ownerMap.get(walletAddress);
  const watchers = watcherIndex.get(walletAddress) ?? new Set<string>();

  if (ownerTid) {
    await handleOwnAccountEvent(walletAddress, ownerTid, event);
  }

  const externalWatchers = [...watchers].filter((tid) => tid !== ownerTid);
  if (externalWatchers.length > 0) {
    await handleMonitoredWalletEvent(walletAddress, externalWatchers, event);
  }
}

async function handleOwnAccountEvent(
  walletAddress: string,
  telegramId: string,
  event: TraderStateEvent,
) {
  const prevKey = `ws:positions:${walletAddress}`;
  const prev = await redis.get(prevKey);
  if (prev) {
    const prevPositions = JSON.parse(prev) as TraderStateEvent["positions"];
    for (const pos of event.positions ?? []) {
      const prevPos = prevPositions.find((p) => p.symbol === pos.symbol);
      if (prevPos && prevPos.side !== pos.side) {
        await alertQueue.add("tpsl-flip", {
          telegramId,
          type: "tpsl_flip",
          symbol: pos.symbol,
          message: [
            `🔄 <b>Position Flipped: ${pos.symbol}</b>`,
            "Your TP/SL orders were cancelled by the protocol.",
            "Tap /positions to reattach TP/SL.",
          ].join("\n"),
        });
      }
    }
  }
  await redis.set(prevKey, JSON.stringify(event.positions ?? []), "EX", 3600);

  const alertMsg = buildRiskAlertMessage(event);
  if (alertMsg) {
    await alertQueue.add("risk-tier", {
      telegramId,
      type: event.riskTier.toLowerCase(),
      message: alertMsg,
    });
  }

  for (const fill of event.fills ?? []) {
    await alertQueue.add("fill", {
      telegramId,
      type: "fill",
      symbol: fill.symbol,
      message: [
        `✅ <b>Order Filled: ${fill.symbol}</b>`,
        `Side: ${fill.side.toUpperCase()}`,
        `Size: ${fill.size} | Price: $${fill.price}`,
        `Fee: $${fill.fee}`,
      ].join("\n"),
    });

    const userId = await getOwnerUserId(walletAddress);
    if (userId) {
      const notional = Number(fill.size) * Number(fill.price);
      await accrueReferralFee(userId, notional).catch((err) =>
        logger.error({ err }, "Referral fee accrual failed"),
      );
    }
  }
}

async function handleMonitoredWalletEvent(
  walletAddress: string,
  watcherTelegramIds: string[],
  event: TraderStateEvent,
) {
  const short = `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`;

  const prevKey = `ws:positions:${walletAddress}`;
  const prev = await redis.get(prevKey);
  const prevPositions: TraderStateEvent["positions"] = prev ? JSON.parse(prev) : [];

  const positions = event.positions ?? [];

  if (!ownerMap.has(walletAddress)) {
    await redis.set(prevKey, JSON.stringify(positions), "EX", 3600);
  }

  const alerts: { type: string; symbol: string; message: string }[] = [];

  for (const pos of positions) {
    const existed = prevPositions.find((p) => p.symbol === pos.symbol);
    if (!existed) {
      const levPart = pos.leverage ? `\nLeverage: ${pos.leverage}x` : "";
      alerts.push({
        type: "monitor_open",
        symbol: pos.symbol,
        message: `👁 <b>${short} opened ${pos.symbol}</b>\n${pos.side.toUpperCase()} · ${pos.size} ${pos.symbol} @ $${pos.entryPrice}${levPart}`,
      });
    } else if (existed.side !== pos.side) {
      alerts.push({
        type: "monitor_flip",
        symbol: pos.symbol,
        message: `👁 <b>${short} flipped ${pos.symbol}</b>\n${existed.side.toUpperCase()} → ${pos.side.toUpperCase()}`,
      });
    }
  }

  for (const prevPos of prevPositions) {
    const still = positions.find((p) => p.symbol === prevPos.symbol);
    if (!still) {
      alerts.push({
        type: "monitor_close",
        symbol: prevPos.symbol,
        message: `👁 <b>${short} closed ${prevPos.symbol}</b>\nWas ${prevPos.side.toUpperCase()} · ${prevPos.size} ${prevPos.symbol}`,
      });
    }
  }

  for (const fill of event.fills ?? []) {
    alerts.push({
      type: "monitor_fill",
      symbol: fill.symbol,
      message: `👁 <b>${short} filled ${fill.symbol}</b>\n${fill.side.toUpperCase()} · ${fill.size} @ $${fill.price}`,
    });
  }

  for (const telegramId of watcherTelegramIds) {
    for (const alert of alerts) {
      await alertQueue.add("monitor-alert", {
        telegramId,
        type: alert.type,
        symbol: alert.symbol,
        message: alert.message,
      });
    }
  }
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
  ownerMap.delete(walletAddress);
  ownerUserIdCache.delete(walletAddress);
  const watchers = watcherIndex.get(walletAddress);
  if (!watchers || watchers.size === 0) {
    const ws = connections.get(walletAddress);
    ws?.close();
    connections.delete(walletAddress);
    watcherIndex.delete(walletAddress);
  }
}

async function getOwnerUserId(walletAddress: string): Promise<string | null> {
  const cached = ownerUserIdCache.get(walletAddress);
  if (cached) return cached;
  const user = await db.query.users.findFirst({
    where: eq(users.walletAddress, walletAddress),
  });
  if (user) ownerUserIdCache.set(walletAddress, user.id);
  return user?.id ?? null;
}

let allMidsWs: WebSocket | null = null;
let allMidsReconnecting = false;

function subscribeAllMids() {
  if (allMidsWs) return;
  allMidsWs = new WebSocket(config.PHOENIX_WS_URL);

  allMidsWs.on("open", () => {
    allMidsWs?.send(JSON.stringify({ type: "subscribe", subscription: { channel: "allMids" } }));
    logger.info("WS subscribed: allMids");
  });

  allMidsWs.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString()) as Record<string, number>;
      await checkPriceAlerts(data);
    } catch (err) {
      logger.error({ err }, "allMids parse error");
    }
  });

  allMidsWs.on("close", () => {
    allMidsWs = null;
    if (allMidsReconnecting) return;
    allMidsReconnecting = true;
    setTimeout(() => {
      allMidsReconnecting = false;
      subscribeAllMids();
    }, 5000);
  });

  allMidsWs.on("error", (err) => {
    logger.error({ err }, "allMids WS error");
  });
}

type PriceAlertSub = {
  id: string;
  userId: string;
  symbol: string | null;
  triggerPrice: string | null;
  telegramId: string;
};
let _priceAlertCache: PriceAlertSub[] | null = null;
let _priceAlertCacheTs = 0;
const PRICE_ALERT_CACHE_TTL_MS = 30_000;

async function getPriceAlertSubs(): Promise<PriceAlertSub[]> {
  if (_priceAlertCache && Date.now() - _priceAlertCacheTs < PRICE_ALERT_CACHE_TTL_MS) {
    return _priceAlertCache;
  }
  _priceAlertCache = await db
    .select({
      id: alertSubscriptions.id,
      userId: alertSubscriptions.userId,
      symbol: alertSubscriptions.symbol,
      triggerPrice: alertSubscriptions.triggerPrice,
      telegramId: users.telegramId,
    })
    .from(alertSubscriptions)
    .innerJoin(users, eq(alertSubscriptions.userId, users.id))
    .where(and(eq(alertSubscriptions.type, "price"), eq(alertSubscriptions.enabled, true)));
  _priceAlertCacheTs = Date.now();
  return _priceAlertCache;
}

async function checkPriceAlerts(mids: Record<string, number>) {
  const subs = await getPriceAlertSubs();

  for (const sub of subs) {
    if (!sub.symbol || !sub.triggerPrice) continue;
    const current = mids[sub.symbol];
    if (current === undefined) continue;

    const trigger = Number(sub.triggerPrice);
    const dedupKey = `alert:price:${sub.userId}:${sub.symbol}:${trigger}`;
    const fired = await redis.get(dedupKey);
    if (fired) continue;

    const crossed = trigger > 0 ? current >= trigger : current <= Math.abs(trigger);
    if (crossed) {
      await redis.set(dedupKey, "1", "EX", 3600);
      await alertQueue.add("price-alert", {
        telegramId: sub.telegramId,
        type: "price",
        symbol: sub.symbol,
        message: `🔔 <b>Price Alert: ${sub.symbol}</b>\n\nPrice reached <code>$${current}</code>\n(Your target: <code>$${Math.abs(trigger)}</code>)`,
      });
    }
  }
}

async function bootstrap() {
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

  logger.info(
    { ownWallets: ownWallets.length, monitors: monitors.length },
    "WS worker bootstrapped",
  );

  subscribeMonitorEvents();
  subscribeAllMids();
}

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
}

process.on("SIGTERM", () => {
  for (const [, ws] of connections) {
    ws.close();
  }
  if (allMidsWs) allMidsWs.close();
  process.exit(0);
});

bootstrap().catch((err) => {
  logger.error({ err }, "WS worker bootstrap failed");
  process.exit(1);
});
