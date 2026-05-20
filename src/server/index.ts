import cors from "@fastify/cors";
import fastify from "fastify";
import { handleWebhook } from "../bot/index.js";
import { config } from "../config/index.js";
import { healthRoutes } from "./routes/health.js";

export async function createServer() {
  const app = fastify({ logger: false });

  await app.register(cors);
  await app.register(healthRoutes);

  app.post(`/webhook/${config.TELEGRAM_BOT_TOKEN}`, handleWebhook);

  return app;
}
