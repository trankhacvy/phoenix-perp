import { Worker } from "bullmq";
import { bot } from "../../bot/index.js";
import { toBotError } from "../../bot/lib/errors.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import type { AlertJobData } from "../queues.js";

let alertWorker: Worker<AlertJobData> | null = null;

export function startAlertWorker() {
  if (alertWorker) return alertWorker;

  alertWorker = new Worker<AlertJobData>(
    "alerts",
    async (job) => {
      const { telegramId, message } = job.data;

      const dedupKey = `alert:dedup:${telegramId}:${job.data.type}:${job.data.symbol ?? ""}`;
      const already = await redis.set(dedupKey, "1", "EX", 5, "NX");
      if (!already) {
        logger.debug({ telegramId, type: job.data.type }, "Alert deduped");
        return;
      }

      try {
        await bot.api.sendMessage(telegramId, message, {
          parse_mode: "HTML",
          reply_markup: job.data.keyboard ? { inline_keyboard: job.data.keyboard } : undefined,
          link_preview_options: { is_disabled: true },
        });
        logger.info({ telegramId, type: job.data.type }, "Alert sent");
      } catch (err) {
        const be = toBotError(err);
        if (!be.retryable) {
          logger.warn(
            { code: be.code, telegramId, type: job.data.type },
            "Dropping non-retryable alert",
          );
          return;
        }
        throw err;
      }
    },
    {
      connection: redis,
      concurrency: 10,
    },
  );

  alertWorker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Alert job failed");
  });

  logger.info("Alert worker started");
  return alertWorker;
}

export async function stopAlertWorker() {
  if (alertWorker) await alertWorker.close();
}

export function getAlertWorkerStats() {
  if (!alertWorker) return { running: false };
  return { running: !alertWorker.closing };
}
