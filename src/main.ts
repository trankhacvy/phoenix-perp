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

  if (config.NODE_ENV === "production") {
    startLeaderboardScanner().catch((err) => {
      logger.error({ err }, "Leaderboard scanner failed to start (non-fatal)");
    });
  }

  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Create wallet & get started" },
      { command: "portfolio", description: "Full account overview" },
      { command: "long", description: "Open a long position" },
      { command: "short", description: "Open a short position" },
      { command: "positions", description: "View open positions" },
      { command: "markets", description: "Browse all markets" },
      { command: "deposit", description: "Add USDC to your account" },
      { command: "withdraw", description: "Move funds out" },
      { command: "history", description: "Trade history with P&L" },
      { command: "alerts", description: "Toggle alert types" },
      { command: "settings", description: "Slippage & leverage defaults" },
      { command: "referral", description: "Your referral link & stats" },
      { command: "funding", description: "Top funding rates" },
      { command: "leaderboard", description: "Top traders" },
      { command: "help", description: "All commands & help" },
    ]);
    await bot.api.setMyDescription(
      "SuperNova — trade perpetual futures on Phoenix, directly from Telegram.",
    );
    await bot.api.setMyShortDescription("SuperNova — Phoenix perps trading bot on Solana");
  } catch (err) {
    logger.warn({ err }, "Failed to set bot commands/description (non-fatal)");
  }

  if (config.NODE_ENV === "production" && config.WEBHOOK_URL) {
    server = await createServer();
    await server.listen({ port: config.PORT, host: config.HOST });

    if (!config.WEBHOOK_SECRET) {
      logger.warn("WEBHOOK_SECRET not set — webhook endpoint has no secret token validation");
    }

    const webhookUrl = `${config.WEBHOOK_URL}/webhook/${config.TELEGRAM_BOT_TOKEN}`;
    await bot.api.setWebhook(webhookUrl, {
      secret_token: config.WEBHOOK_SECRET,
    });

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

async function shutdown() {
  logger.info("Shutting down…");
  await bot.stop();
  if (server) await server.close();
  stopWsManager();
  await Promise.all([stopAlertWorker(), stopLeaderboardScanner()]);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
