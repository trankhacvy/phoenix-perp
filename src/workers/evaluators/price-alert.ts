import { and, eq } from "drizzle-orm";
import WebSocket from "ws";
import { config } from "../../config/index.js";
import { db } from "../../db/index.js";
import { alertSubscriptions, users } from "../../db/schema/index.js";
import { alertQueue } from "../../jobs/queues.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { esc } from "./shared.js";

let allMidsWs: WebSocket | null = null;
let allMidsReconnecting = false;
let priceAlertCheckRunning = false;
let lastPriceAlertCheckMs = 0;
const PRICE_ALERT_THROTTLE_MS = 1000;
let shuttingDown = false;

interface PriceAlertSub {
  id: string;
  userId: string;
  symbol: string | null;
  triggerPrice: string | null;
  telegramId: string;
}

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

export function bustPriceAlertCache() {
  _priceAlertCache = null;
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

      const direction = trigger > 0 ? "🔼 above" : "🔽 below";
      await alertQueue.add("price-alert", {
        telegramId: sub.telegramId,
        type: "price",
        symbol: sub.symbol,
        message: [
          `🔔 <b>Price Alert: ${esc(sub.symbol)}</b>`,
          "",
          `${esc(sub.symbol)} reached <code>$${esc(current)}</code>`,
          `Your target was <code>$${esc(Math.abs(trigger))}</code> (${direction})`,
          "",
          "This alert has been auto-disabled.",
        ].join("\n"),
        keyboard: [
          [
            { text: `📈 ${sub.symbol} Market`, callback_data: `market:detail:${sub.symbol}:0` },
            { text: `🟢 Long ${sub.symbol}`, callback_data: `trade:long:${sub.symbol}` },
            { text: `🔴 Short ${sub.symbol}`, callback_data: `trade:short:${sub.symbol}` },
          ],
          [{ text: "🔁 Re-enable alert", callback_data: `al:pa:reenable:${sub.id}` }],
        ],
      });

      await db
        .update(alertSubscriptions)
        .set({ enabled: false })
        .where(eq(alertSubscriptions.id, sub.id));
      _priceAlertCache = null;
    }
  }
}

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

export function startPriceAlertWatcher() {
  shuttingDown = false;
  subscribeAllMids();
}

export function stopPriceAlertWatcher() {
  shuttingDown = true;
  if (allMidsWs) allMidsWs.close();
}
