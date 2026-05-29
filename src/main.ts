import { createHash } from "node:crypto";
import "dotenv/config";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { bot } from "./bot/index.js";
import { config } from "./config/index.js";
import { db } from "./db/index.js";
import { startAlertWorker, stopAlertWorker } from "./jobs/processors/alert.js";
import { logger } from "./lib/logger.js";
import { createServer } from "./server/index.js";
import { closePhoenixWsClient } from "./services/phoenix/client.js";
import { startAllMarketStats, stopMarketStatsFeed } from "./services/phoenix/market-stats-feed.js";
import { startPriceFeed, stopPriceFeed } from "./services/phoenix/price-feed.js";
import { startEvalLoop, stopEvalLoop } from "./workers/eval-loop.js";
import { startPriceAlertWatcher, stopPriceAlertWatcher } from "./workers/evaluators/price-alert.js";
import { startLeaderboardScanner, stopLeaderboardScanner } from "./workers/leaderboard.js";
import { startRestRefreshLoop, stopRestRefreshLoop } from "./workers/rest-refresh.js";
import { startWsManager, stopWsManager } from "./workers/ws.js";

const ACTION_LOG_RETENTION_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

let server: FastifyInstance | null = null;

function startActionLogRetention() {
  const run = async () => {
    try {
      await db.execute(
        sql`DELETE FROM action_logs WHERE created_at < NOW() - INTERVAL '1 day' * ${ACTION_LOG_RETENTION_DAYS}`,
      );
    } catch (err) {
      logger.warn({ err }, "action log retention sweep failed");
    }
  };
  run();
  setInterval(run, ONE_DAY_MS);
}

async function main() {
  startActionLogRetention();

  startAlertWorker();
  startRestRefreshLoop();
  startPriceFeed();
  startAllMarketStats();
  startPriceAlertWatcher();
  startEvalLoop();

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
      { command: "guardian", description: "Risk rules & auto-protection" },
      { command: "alerts", description: "Toggle alert types" },
      { command: "settings", description: "Slippage & leverage defaults" },
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

    const webhookSlug = createHash("sha256")
      .update(config.TELEGRAM_BOT_TOKEN)
      .digest("hex")
      .slice(0, 32);
    const webhookUrl = `${config.WEBHOOK_URL}/webhook/${webhookSlug}`;
    await bot.api.setWebhook(webhookUrl, {
      secret_token: config.WEBHOOK_SECRET,
    });

    logger.info({ port: config.PORT }, "Bot running in webhook mode");
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
  stopEvalLoop();
  stopPriceAlertWatcher();
  stopPriceFeed();
  stopMarketStatsFeed();
  stopRestRefreshLoop();
  closePhoenixWsClient();
  await Promise.all([stopAlertWorker(), stopLeaderboardScanner()]);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — initiating shutdown");
  shutdown();
});
