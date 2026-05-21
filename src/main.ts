import "dotenv/config";
import { bot } from "./bot/index.js";
import { config } from "./config/index.js";
import { logger } from "./lib/logger.js";
import { createServer } from "./server/index.js";
import { initTestSigner } from "./services/wallet.js";

async function main() {
  if (process.env.TEST_KEYPAIR) {
    const addr = await initTestSigner();
    logger.info({ walletAddress: addr }, "Test signer loaded from TEST_KEYPAIR");
  }
  if (config.NODE_ENV === "production" && config.WEBHOOK_URL) {
    const server = await createServer();
    await server.listen({ port: config.PORT, host: config.HOST });

    const webhookUrl = `${config.WEBHOOK_URL}/webhook/${config.TELEGRAM_BOT_TOKEN}`;
    await bot.api.setWebhook(webhookUrl);

    logger.info({ port: config.PORT, webhookUrl }, "Bot running in webhook mode");
  } else {
    // Long polling for local dev — no server needed
    await bot.start({
      onStart: (info) => logger.info({ username: info.username }, "Bot running in polling mode"),
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
