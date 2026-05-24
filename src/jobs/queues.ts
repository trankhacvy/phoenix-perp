import { Queue } from "bullmq";
import { redis } from "../lib/redis.js";

export const alertQueue = new Queue("alerts", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export type AlertButton = { text: string; callback_data: string };

export interface AlertJobData {
  telegramId: string;
  type: string;
  message: string;
  symbol?: string;
  keyboard?: AlertButton[][];
}
