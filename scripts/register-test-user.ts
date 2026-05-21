/**
 * Register your Telegram account in the DB pointing to TEST_KEYPAIR wallet.
 * Run once before testing via the real Telegram bot.
 *
 * Usage:
 *   TELEGRAM_ID=<your_telegram_id> npx tsx scripts/register-test-user.ts
 *
 * To find your Telegram ID: message @userinfobot on Telegram.
 */
import "dotenv/config";
import { createKeyPairSignerFromBytes } from "@solana/signers";
import bs58 from "bs58";
import postgres from "postgres";

const telegramId = process.env.TELEGRAM_ID;
if (!telegramId) {
  console.error("Set TELEGRAM_ID env var. Message @userinfobot on Telegram to get your ID.");
  process.exit(1);
}

const raw = process.env.TEST_KEYPAIR;
if (!raw) { console.error("TEST_KEYPAIR not set"); process.exit(1); }
const signer = await createKeyPairSignerFromBytes(bs58.decode(raw));
const walletAddress = signer.address as string;

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  INSERT INTO users (id, telegram_id, username, first_name, privy_user_id, wallet_address, phoenix_activated, referral_code, created_at, updated_at)
  VALUES (${telegramId}, ${telegramId}, 'testuser', 'TestUser', 'test_privy_id', ${walletAddress}, true, ${"REF" + telegramId.slice(-4)}, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE SET wallet_address = ${walletAddress}, phoenix_activated = true, updated_at = NOW()
`;

console.log(`✓ Registered Telegram ID ${telegramId} → wallet ${walletAddress}`);
await sql.end();
