import WebSocket from "ws";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { alertSubscriptions, users } from "../db/schema/index.js";
import { alertQueue } from "../jobs/queues.js";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import { accrueReferralFee } from "../services/referral.js";
import type { RiskTier, TraderStateEvent } from "../types/index.js";

const connections = new Map<string, WebSocket>();
const userCache = new Map<string, string>();

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

export async function subscribeUser(walletAddress: string, telegramId: string) {
  if (connections.has(walletAddress)) return;

  userCache.set(walletAddress, telegramId);
  const ws = new WebSocket(config.PHOENIX_WS_URL);
  connections.set(walletAddress, ws);

  ws.on("open", () => {
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

      const prevKey = `ws:positions:${walletAddress}`;
      const prev = await redis.get(prevKey);
      if (prev) {
        const prevPositions = JSON.parse(prev) as TraderStateEvent["positions"];
        for (const pos of event.positions) {
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
      await redis.set(prevKey, JSON.stringify(event.positions), "EX", 3600);

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

        const userId = await getUserId(walletAddress);
        if (userId) {
          const notional = Number(fill.size) * Number(fill.price);
          await accrueReferralFee(userId, notional).catch((err) =>
            logger.error({ err }, "Referral fee accrual failed"),
          );
        }
      }
    } catch (err) {
      logger.error({ err, walletAddress }, "WS message parse error");
    }
  });

  ws.on("close", () => {
    connections.delete(walletAddress);
    logger.info({ walletAddress }, "WS closed");
    setTimeout(() => subscribeUser(walletAddress, telegramId), 5000);
  });

  ws.on("error", (err) => {
    logger.error({ err, walletAddress }, "WS error");
  });
}

export function unsubscribeUser(walletAddress: string) {
  const ws = connections.get(walletAddress);
  if (ws) {
    ws.close();
    connections.delete(walletAddress);
    userCache.delete(walletAddress);
  }
}

async function getUserId(walletAddress: string): Promise<string | null> {
  const cached = userCache.get(walletAddress);
  if (cached) return cached;
  const user = await db.query.users.findFirst({
    where: eq(users.walletAddress, walletAddress),
  });
  if (user) userCache.set(walletAddress, user.id);
  return user?.id ?? null;
}

let allMidsWs: WebSocket | null = null;

function subscribeAllMids() {
  if (allMidsWs) return;
  allMidsWs = new WebSocket(config.PHOENIX_WS_URL);

  allMidsWs.on("open", () => {
    allMidsWs!.send(JSON.stringify({ type: "subscribe", subscription: { channel: "allMids" } }));
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
    setTimeout(subscribeAllMids, 5000);
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
  const keys = await redis.keys("ws:positions:*");
  if (keys.length === 0) {
    logger.info({ count: 0 }, "WS worker bootstrapped");
    subscribeAllMids();
    return;
  }

  const walletAddresses = keys.map((k) => k.replace("ws:positions:", ""));
  const dbUsers = await db
    .select({ walletAddress: users.walletAddress, telegramId: users.telegramId })
    .from(users)
    .where(inArray(users.walletAddress, walletAddresses));

  for (const user of dbUsers) {
    await subscribeUser(user.walletAddress, user.telegramId);
  }
  logger.info({ count: dbUsers.length }, "WS worker bootstrapped");
  subscribeAllMids();
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
