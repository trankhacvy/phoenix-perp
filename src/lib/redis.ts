import { Redis } from "ioredis";
import { config } from "../config/index.js";
import { logger } from "./logger.js";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redis.on("error", (err: Error) => logger.error({ err }, "Redis error"));
redis.on("connect", () => logger.info("Redis connected"));
