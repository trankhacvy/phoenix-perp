import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  WEBHOOK_URL: z.string().url().optional(),

  // Privy
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),

  // Phoenix / Flight
  BUILDER_AUTHORITY_PUBKEY: z.string().min(1),
  BUILDER_ACCESS_CODE: z.string().min(1),
  BUILDER_FEE_BPS: z.coerce.number().min(1).max(50).default(10),
  PHOENIX_API_URL: z.string().url().default("https://perp-api.phoenix.trade"),
  PHOENIX_WS_URL: z.string().default("wss://perp-api.phoenix.trade/v1/ws"),

  // Solana
  HELIUS_RPC_URL: z.string().url(),

  // Database
  DATABASE_URL: z.string().min(1),

  // Redis
  REDIS_URL: z.string().min(1),

  // Server
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
