import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { alertSubscriptions, users } from "../../db/schema/index.js";
import { alertQueue } from "../../jobs/queues.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { onMids } from "../../services/phoenix/price-feed.js";
import { esc } from "./shared.js";

let priceAlertCheckRunning = false;
let lastPriceAlertCheckMs = 0;
const PRICE_ALERT_THROTTLE_MS = 1000;
let unsubscribe: (() => void) | null = null;

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

export async function checkPriceAlerts(mids: ReadonlyMap<string, number>) {
  const subs = await getPriceAlertSubs();

  for (const sub of subs) {
    if (!sub.symbol || !sub.triggerPrice) continue;
    const current = mids.get(sub.symbol.toUpperCase());
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

export function startPriceAlertWatcher() {
  if (unsubscribe) return;
  unsubscribe = onMids(async (mids) => {
    const now = Date.now();
    if (priceAlertCheckRunning || now - lastPriceAlertCheckMs < PRICE_ALERT_THROTTLE_MS) return;
    priceAlertCheckRunning = true;
    lastPriceAlertCheckMs = now;
    try {
      await checkPriceAlerts(mids);
    } catch (err) {
      logger.error({ err }, "price alert check failed");
    } finally {
      priceAlertCheckRunning = false;
    }
  });
}

export function stopPriceAlertWatcher() {
  unsubscribe?.();
  unsubscribe = null;
}
