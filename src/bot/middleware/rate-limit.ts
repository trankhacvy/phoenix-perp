import type { NextFunction } from "grammy";
import { redis } from "../../lib/redis.js";
import type { BotContext } from "../../types/index.js";

const LIMIT = 20;
const WINDOW_SECONDS = 60;

const ORDER_LIMIT = 5;

export async function rateLimitMiddleware(ctx: BotContext, next: NextFunction) {
  if (!ctx.from) return next();

  const key = `ratelimit:${ctx.from.id}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  if (count > LIMIT) {
    await ctx.reply("Too many requests. Please wait a moment.");
    return;
  }

  return next();
}

export async function orderRateLimitMiddleware(ctx: BotContext, next: NextFunction) {
  if (!ctx.from) return next();

  const key = `ratelimit:orders:${ctx.from.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SECONDS);

  if (count > ORDER_LIMIT) {
    await ctx.reply("Too many orders. Please wait a minute.");
    return;
  }

  return next();
}
