import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { users, walletMonitors } from "../src/db/schema/index.js";

async function main() {
  const key = process.env.DEV_SIGNER_SECRET_KEY;
  if (!key) {
    console.error("DEV_SIGNER_SECRET_KEY not set");
    process.exit(1);
  }
  const kp = Keypair.fromSecretKey(bs58.decode(key));
  const devWallet = kp.publicKey.toBase58();
  console.log(`DEV signer wallet: ${devWallet}\n`);

  const all = await db
    .select({ id: users.id, telegramId: users.telegramId, wallet: users.walletAddress, activated: users.phoenixActivated })
    .from(users);
  console.log(`users (${all.length}):`);
  for (const u of all) {
    const tag = u.wallet === devWallet ? "  <== DEV signer" : "";
    console.log(`  tid=${u.telegramId} wallet=${u.wallet} activated=${u.activated}${tag}`);
  }

  console.log("");
  for (const u of all) {
    const mons = await db
      .select({ watched: walletMonitors.watchedWallet, enabled: walletMonitors.enabled })
      .from(walletMonitors)
      .where(eq(walletMonitors.userId, u.id));
    if (mons.length > 0) {
      console.log(`monitors for tid=${u.telegramId}: ${JSON.stringify(mons)}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
