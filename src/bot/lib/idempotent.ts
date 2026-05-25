import { redis } from "../../lib/redis.js";

export async function claimIdempotencyKey(
  userId: number | string,
  callbackId: string,
  ttlSeconds = 120,
): Promise<boolean> {
  const key = `idem:${userId}:${callbackId}`;
  const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
  return result !== null;
}
