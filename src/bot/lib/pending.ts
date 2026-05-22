import { redis } from "../../lib/redis.js";

const TTL = 600;

export async function setPending(telegramId: number | string, value: string): Promise<void> {
  await redis.set(`pending:${telegramId}`, value, "EX", TTL);
}

export async function getPending(telegramId: number | string): Promise<string | null> {
  return redis.get(`pending:${telegramId}`);
}

export async function clearPending(telegramId: number | string): Promise<void> {
  await redis.del(`pending:${telegramId}`);
}
