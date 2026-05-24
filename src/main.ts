import "dotenv/config";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { bot } from "./bot/index.js";
import { config } from "./config/index.js";
import { db } from "./db/index.js";
import { startAlertWorker, stopAlertWorker } from "./jobs/processors/alert.js";
import { logger } from "./lib/logger.js";
import { createServer } from "./server/index.js";
import { initTestSigner } from "./services/wallet.js";
import { startLeaderboardScanner, stopLeaderboardScanner } from "./workers/leaderboard.js";
import { startWsManager, stopWsManager } from "./workers/ws.js";

const ACTION_LOG_RETENTION_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

let server: FastifyInstance | null = null;

function startActionLogRetention() {
  const run = async () => {
    try {
      await db.execute(
        sql`DELETE FROM action_logs WHERE created_at < NOW() - INTERVAL '${sql.raw(String(ACTION_LOG_RETENTION_DAYS))} days'`,
      );
    } catch (err) {
      logger.warn({ err }, "action log retention sweep failed");
    }
  };
  run();
  setInterval(run, ONE_DAY_MS);
}

async function main() {
  if (config.TEST_KEYPAIR) {
    const addr = await initTestSigner();
    logger.info({ walletAddress: addr }, "Test signer loaded from TEST_KEYPAIR");
  }

  startActionLogRetention();

  startAlertWorker();

  await startWsManager();

  // startLeaderboardScanner().catch((err) => {
  //   logger.error({ err }, "Leaderboard scanner failed to start (non-fatal)");
  // });

  if (config.NODE_ENV === "production" && config.WEBHOOK_URL) {
    server = await createServer();
    await server.listen({ port: config.PORT, host: config.HOST });

    const webhookUrl = `${config.WEBHOOK_URL}/webhook/${config.TELEGRAM_BOT_TOKEN}`;
    await bot.api.setWebhook(webhookUrl);

    logger.info({ port: config.PORT, webhookUrl }, "Bot running in webhook mode");
  } else {
    bot.start({
      onStart: (info) => logger.info({ username: info.username }, "Bot running in polling mode"),
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down");
  await bot.stop();
  if (server) await server.close();
  stopWsManager();
  await Promise.all([stopAlertWorker(), stopLeaderboardScanner()]);
  process.exit(0);
});
