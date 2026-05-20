import { Worker } from "bullmq";
import { bot } from "../../bot/index.js";
import { redis } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";
import type { AlertJobData } from "../queues.js";

export const alertWorker = new Worker<AlertJobData>(
  "alerts",
  async (job) => {
    const { telegramId, message } = job.data;

    // Telegram rate limit: 1 msg/sec per user chat
    // Redis dedup: skip if same alert type sent within 5s
    const dedupKey = `alert:dedup:${telegramId}:${job.data.type}:${job.data.symbol ?? ""}`;
    const already = await redis.set(dedupKey, "1", "EX", 5, "NX");
    if (!already) {
      logger.debug({ telegramId, type: job.data.type }, "Alert deduped");
      return;
    }

    await bot.api.sendMessage(telegramId, message, { parse_mode: "HTML" });
    logger.info({ telegramId, type: job.data.type }, "Alert sent");
  },
  {
    connection: redis,
    concurrency: 10,
  },
);

alertWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "Alert job failed");
});
