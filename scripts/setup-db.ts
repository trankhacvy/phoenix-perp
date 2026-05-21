/**
 * One-time DB setup script. Creates all tables and enums using raw SQL,
 * bypassing drizzle-kit (which can't handle ESM .js extension imports in schema files).
 *
 * Usage:
 *   npx tsx scripts/setup-db.ts
 */

import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  DO $$ BEGIN
    CREATE TYPE alert_type AS ENUM (
      'at_risk', 'cancellable', 'liquidatable', 'fill',
      'tpsl_flip', 'price', 'funding_flip', 'large_funding'
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END $$
`;

await sql`
  DO $$ BEGIN
    CREATE TYPE referral_tier AS ENUM ('t1', 't2');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$
`;

await sql`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    privy_user_id TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    phoenix_activated BOOLEAN NOT NULL DEFAULT FALSE,
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS alert_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type alert_type NOT NULL,
    symbol TEXT,
    trigger_price TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS referrals (
    id TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL REFERENCES users(id),
    referee_id TEXT NOT NULL REFERENCES users(id),
    tier referral_tier NOT NULL,
    accrued_usdc NUMERIC(20,6) NOT NULL DEFAULT '0',
    claimed_usdc NUMERIC(20,6) NOT NULL DEFAULT '0',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    slippage_bps INTEGER NOT NULL DEFAULT 50,
    default_leverage INTEGER NOT NULL DEFAULT 5,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`;

console.log("✓ All tables created");
await sql.end();
