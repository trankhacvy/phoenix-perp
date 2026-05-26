import { and, eq, isNull } from "drizzle-orm";
import { Redis } from "ioredis";
import WebSocket from "ws";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { alertSubscriptions, users, walletMonitors } from "../db/schema/index.js";
import { type AlertButton, alertQueue } from "../jobs/queues.js";
import { MONITOR_EVENTS_CHANNEL } from "../lib/constants.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { isIsolatedOnly } from "../services/phoenix/market.js";
import { accrueReferralFee } from "../services/referral.js";
import type { RiskTier, TraderStateEvent } from "../types/index.js";

type MonitorEvent =
  | { action: "subscribe"; wallet: string; telegramId: string }
  | { action: "unsubscribe"; wallet: string; telegramId: string };

function esc(s: string | number): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const connections = new Map<string, WebSocket>();
const reconnecting = new Set<string>();
const reconnectFailures = new Map<string, number>();
const MAX_RECONNECT_FAILURES = 3;
const MAX_WS_CONNECTIONS = 500;
let shuttingDown = false;

// wallet → Set of telegramIds that want alerts for this wallet (all watchers)
const watcherIndex = new Map<string, Set<string>>();

// wallet → ownerTelegramId (the bot user whose embedded wallet this is)
// Monitored-only wallets have no entry here.
const ownerMap = new Map<string, string>();

// wallet → userId (DB id, for referral accrual)
const ownerUserIdCache = new Map<string, string>();

const ALERT_ENABLED_DEFAULTS: Record<string, boolean> = {
  at_risk: true,
  cancellable: true,
  liquidatable: true,
  tpsl_flip: true,
};

const ALERT_ENABLED_CACHE_TTL_MS = 30_000;
const _alertEnabledCache = new Map<string, { enabled: boolean; ts: number }>();

type AlertTypeValue = (typeof alertSubscriptions.type.enumValues)[number];

async function isAlertEnabled(userId: string, alertType: string): Promise<boolean> {
  const cacheKey = `${userId}:${alertType}`;
  const cached = _alertEnabledCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ALERT_ENABLED_CACHE_TTL_MS) return cached.enabled;

  const row = await db.query.alertSubscriptions.findFirst({
    where: and(
      eq(alertSubscriptions.userId, userId),
      eq(alertSubscriptions.type, alertType as AlertTypeValue),
      isNull(alertSubscriptions.symbol),
    ),
  });

  const enabled = row ? row.enabled : (ALERT_ENABLED_DEFAULTS[alertType] ?? true);
  _alertEnabledCache.set(cacheKey, { enabled, ts: Date.now() });
  return enabled;
}

const RISK_DEDUP_TTL = 300;
const TPSL_DEDUP_TTL = 60;

const RISK_ALERT_TIERS: RiskTier[] = [
  "atRisk",
  "at_risk",
  "cancellable",
  "liquidatable",
  "backstopLiquidatable",
  "highRisk",
];

const NAV_RISK_KB: AlertButton[][] = [
  [
    { text: "📊 Positions", callback_data: "nav:positions" },
    { text: "📥 Deposit", callback_data: "nav:deposit" },
  ],
];

interface AlertPayload {
  message: string;
  keyboard?: AlertButton[][];
}

function riskAlertType(tier: RiskTier): string {
  if (tier === "atRisk" || tier === "at_risk") return "at_risk";
  if (tier === "cancellable") return "cancellable";
  return "liquidatable";
}

function buildRiskAlert(event: TraderStateEvent): (AlertPayload & { alertType: string }) | null {
  if (!RISK_ALERT_TIERS.includes(event.riskTier)) return null;
  const col = esc(`$${Number(event.effectiveCollateral).toFixed(2)}`);
  const tier = event.riskTier;

  const messages: Record<string, string> = {
    atRisk: `⚠️ <b>Margin Low</b>\n\nYour collateral (${col}) dropped below initial margin.\nYou can't open new positions until you add funds or close existing ones.`,
    at_risk: `⚠️ <b>Margin Low</b>\n\nYour collateral (${col}) dropped below initial margin.\nYou can't open new positions until you add funds or close existing ones.`,
    cancellable: `🟠 <b>Margin Warning</b>\n\nYour collateral (${col}) is critically low.\nOpen orders may be force-cancelled to protect your account.`,
    liquidatable: `🚨 <b>Liquidation Risk</b>\n\nYour account (${col}) can be liquidated.\nDeposit funds or close positions immediately.`,
    backstopLiquidatable: `🆘 <b>Liquidation Imminent</b>\n\nYour account (${col}) is past the normal liquidation threshold.\nAct now — deposit or close everything.`,
    highRisk: `🆘 <b>Liquidation Imminent</b>\n\nYour account (${col}) is deeply underwater.\nAct now — deposit or close everything.`,
  };

  const msg = messages[tier];
  if (!msg) return null;
  return { message: msg, keyboard: NAV_RISK_KB, alertType: riskAlertType(tier) };
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
  // userId = DB primary key (users.id). Today it equals telegramId, but
  // getOwnerUserId is the canonical lookup so this survives a PK change.
  const userId = (await getOwnerUserId(walletAddress)) ?? telegramId;

  const prevKey = `ws:positions:${walletAddress}`;
  const prev = await redis.get(prevKey);
  if (prev) {
    const prevPositions = JSON.parse(prev) as TraderStateEvent["positions"];
    for (const pos of event.positions ?? []) {
      const prevPos = prevPositions.find((p) => p.symbol === pos.symbol);
      if (prevPos && prevPos.side !== pos.side) {
        if (await isAlertEnabled(userId, "tpsl_flip")) {
          const dedupKey = `ws:dedup:${telegramId}:tpsl_flip:${pos.symbol}`;
          const isNew = await redis.set(dedupKey, "1", "EX", TPSL_DEDUP_TTL, "NX");
          if (isNew) {
            const newSide = pos.side === "long" ? "LONG" : "SHORT";
            await alertQueue.add("tpsl-flip", {
              telegramId,
              type: "tpsl_flip",
              symbol: pos.symbol,
              message: [
                `🔄 <b>${esc(pos.symbol)} flipped to ${newSide}</b>`,
                "",
                `Your ${esc(pos.symbol)} position changed direction.`,
                "Previous TP/SL orders were cancelled.",
                "",
                `Set new TP/SL to protect your ${newSide.toLowerCase()} position.`,
              ].join("\n"),
              keyboard: [
                [
                  {
                    text: "🛑 Set SL",
                    callback_data: `tpsl:open:sl:${pos.symbol}:${pos.side}`,
                  },
                  {
                    text: "🎯 Set TP",
                    callback_data: `tpsl:open:tp:${pos.symbol}:${pos.side}`,
                  },
                ],
                [{ text: "📊 Positions", callback_data: "nav:positions" }],
              ],
            });
          }
        }
      }
    }
  }
  await redis.set(prevKey, JSON.stringify(event.positions ?? []), "EX", 3600);

  const riskAlert = buildRiskAlert(event);
  if (riskAlert) {
    if (await isAlertEnabled(userId, riskAlert.alertType)) {
      const symbols = (event.positions ?? []).map((p) => p.symbol).join(",");
      const dedupKey = `ws:dedup:${telegramId}:risk:${riskAlert.alertType}`;
      const isNew = await redis.set(dedupKey, "1", "EX", RISK_DEDUP_TTL, "NX");
      if (isNew) {
        await alertQueue.add("risk-tier", {
          telegramId,
          type: riskAlert.alertType,
          symbol: symbols || undefined,
          message: riskAlert.message,
          keyboard: riskAlert.keyboard,
        });
      }
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

function copyCounterKb(
  symbol: string,
  side: "long" | "short",
  walletAddress: string,
): AlertButton[][] {
  const counter = side === "long" ? "short" : "long";
  const copyLabel = side === "long" ? "🟢 Copy Long" : "🔴 Copy Short";
  const counterLabel = counter === "long" ? "🟢 Counter Long" : "🔴 Counter Short";
  const rows: AlertButton[][] = [];
  if (!isIsolatedOnly(symbol)) {
    rows.push([
      { text: `${copyLabel} ${symbol}`, callback_data: `trade:${side}:${symbol}` },
      { text: `${counterLabel} ${symbol}`, callback_data: `trade:${counter}:${symbol}` },
    ]);
  }
  rows.push([{ text: "📊 Trader", callback_data: `walletinfo:back:${walletAddress}` }]);
  return rows;
}

function traderKb(walletAddress: string): AlertButton[][] {
  return [[{ text: "📊 Trader", callback_data: `walletinfo:back:${walletAddress}` }]];
}

async function handleMonitoredWalletEvent(
  walletAddress: string,
  watcherTelegramIds: string[],
  event: TraderStateEvent,
) {
  const short = walletAddress;

  const prevKey = `ws:positions:${walletAddress}`;
  const prev = await redis.get(prevKey);

  const positions = event.positions ?? [];

  if (!ownerMap.has(walletAddress)) {
    await redis.set(prevKey, JSON.stringify(positions), "EX", 3600);
  }

  // First event after subscribe / Redis TTL expiry — seed cache, skip diff
  // to avoid false "opened" alerts for already-existing positions.
  if (!prev) return;

  const prevPositions = JSON.parse(prev) as TraderStateEvent["positions"];

  const alerts: { type: string; symbol: string; message: string; keyboard?: AlertButton[][] }[] =
    [];

  const shortEsc = esc(short);

  for (const pos of positions) {
    const existed = prevPositions.find((p) => p.symbol === pos.symbol);
    if (!existed) {
      const levPart = pos.leverage ? ` · ${esc(pos.leverage)}x` : "";
      alerts.push({
        type: "monitor_open",
        symbol: pos.symbol,
        message: `👁 <b>${shortEsc} opened ${esc(pos.symbol)}</b>\n${esc(pos.side.toUpperCase())} · ${esc(pos.size)} ${esc(pos.symbol)} @ $${esc(pos.entryPrice)}${levPart}`,
        keyboard: copyCounterKb(pos.symbol, pos.side, walletAddress),
      });
    } else if (existed.side !== pos.side) {
      alerts.push({
        type: "monitor_flip",
        symbol: pos.symbol,
        message: `👁 <b>${shortEsc} flipped ${esc(pos.symbol)}</b>\n${esc(existed.side.toUpperCase())} → ${esc(pos.side.toUpperCase())}`,
        keyboard: copyCounterKb(pos.symbol, pos.side, walletAddress),
      });
    }
  }

  for (const prevPos of prevPositions) {
    const still = positions.find((p) => p.symbol === prevPos.symbol);
    if (!still) {
      alerts.push({
        type: "monitor_close",
        symbol: prevPos.symbol,
        message: `👁 <b>${shortEsc} closed ${esc(prevPos.symbol)}</b>\nWas ${esc(prevPos.side.toUpperCase())} · ${esc(prevPos.size)} ${esc(prevPos.symbol)}`,
        keyboard: traderKb(walletAddress),
      });
    }
  }

  for (const fill of event.fills ?? []) {
    alerts.push({
      type: "monitor_fill",
      symbol: fill.symbol,
      message: `👁 <b>${shortEsc} filled ${esc(fill.symbol)}</b>\n${esc(fill.side.toUpperCase())} · ${esc(fill.size)} @ $${esc(fill.price)}`,
      keyboard: traderKb(walletAddress),
    });
  }

  for (const telegramId of watcherTelegramIds) {
    for (const alert of alerts) {
      await alertQueue.add("monitor-alert", {
        telegramId,
        type: alert.type,
        symbol: alert.symbol,
        message: alert.message,
        keyboard: alert.keyboard,
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

let allMidsWs: WebSocket | null = null;
let allMidsReconnecting = false;
let priceAlertCheckRunning = false;
let lastPriceAlertCheckMs = 0;
const PRICE_ALERT_THROTTLE_MS = 1000;

function subscribeAllMids() {
  if (allMidsWs) return;
  allMidsWs = new WebSocket(config.PHOENIX_WS_URL);

  allMidsWs.on("open", () => {
    allMidsWs?.send(JSON.stringify({ type: "subscribe", subscription: { channel: "allMids" } }));
    logger.info("WS subscribed: allMids");
  });

  allMidsWs.on("message", async (raw) => {
    const now = Date.now();
    if (priceAlertCheckRunning || now - lastPriceAlertCheckMs < PRICE_ALERT_THROTTLE_MS) return;
    priceAlertCheckRunning = true;
    lastPriceAlertCheckMs = now;
    try {
      const data = JSON.parse(raw.toString()) as Record<string, number>;
      await checkPriceAlerts(data);
    } catch (err) {
      logger.error({ err }, "allMids parse error");
    } finally {
      priceAlertCheckRunning = false;
    }
  });

  allMidsWs.on("close", () => {
    allMidsWs = null;
    if (shuttingDown || allMidsReconnecting) return;
    allMidsReconnecting = true;
    setTimeout(() => {
      allMidsReconnecting = false;
      if (!shuttingDown) subscribeAllMids();
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
        message: `🔔 <b>Price Alert: ${esc(sub.symbol)}</b>\n\nPrice reached <code>$${esc(current)}</code>\n(Your target: <code>$${esc(Math.abs(trigger))}</code>)`,
        keyboard: [
          [{ text: `📊 ${sub.symbol} Market`, callback_data: `market:detail:${sub.symbol}:0` }],
        ],
      });
    }
  }
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
  subscribeAllMids();
}

export function stopWsManager() {
  shuttingDown = true;
  for (const [, ws] of connections) ws.close();
  if (allMidsWs) allMidsWs.close();
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
