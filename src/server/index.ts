import cors from "@fastify/cors";
import fastify from "fastify";
import { handleWebhook } from "../bot/index.js";
import { config } from "../config/index.js";
import { healthRoutes } from "./routes/health.js";

export async function createServer() {
  const app = fastify({ logger: false });

  await app.register(cors);
  await app.register(healthRoutes);

  const webhookHandler = handleWebhook();
  app.post(`/webhook/${config.TELEGRAM_BOT_TOKEN}`, async (req, reply) => {
    if (config.WEBHOOK_SECRET) {
      const token = req.headers["x-telegram-bot-api-secret-token"];
      if (token !== config.WEBHOOK_SECRET) {
        return reply.code(401).send("Unauthorized");
      }
    }
    return webhookHandler(req, reply);
  });

  return app;
}
