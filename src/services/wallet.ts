import * as crypto from "node:crypto";
import { type SolanaKitSigner, createSolanaKitSigner } from "@privy-io/node/solana-kit";
import type { Address } from "@solana/kit";
import { Connection, PublicKey } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { users } from "../db/schema/index.js";
import { privy } from "../lib/privy.js";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const _rpcConnection = new Connection(config.HELIUS_RPC_URL, "confirmed");

/**
 * Returns the wallet's idle standard USDC balance (in dollars, decimal).
 * This is the USDC sitting in the user's Privy wallet token account —
 * NOT the Phoenix trader PDA collateral.
 */
export async function getWalletUsdcBalance(walletAddress: string): Promise<number> {
  const owner = new PublicKey(walletAddress);
  const res = await _rpcConnection.getParsedTokenAccountsByOwner(owner, {
    mint: USDC_MINT,
  });
  let total = 0;
  for (const { account } of res.value) {
    const amount = account.data.parsed?.info?.tokenAmount?.uiAmount;
    if (typeof amount === "number") total += amount;
  }
  return total;
}

/** Returns SOL balance in SOL (not lamports). Returns 0 on RPC error. */
export async function getSolBalance(walletAddress: string): Promise<number> {
  const lamports = await _rpcConnection.getBalance(new PublicKey(walletAddress)).catch(() => 0);
  return lamports / 1e9;
}

/** Derives SPKI/DER/base64 public key from the Privy authorization private key. */
function getAppPublicKey(): string {
  const raw = config.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  const stripped = raw.replace("wallet-auth:", "").replace("wallet-api:", "");
  const pkcs8 = Buffer.from(stripped, "base64");
  const privKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pubKey = crypto.createPublicKey(privKey);
  return Buffer.from(pubKey.export({ type: "spki", format: "der" })).toString("base64");
}

export async function createEmbeddedWallet(telegramUserId: string) {
  const user = await privy.users().create({
    linked_accounts: [{ type: "telegram", telegram_user_id: telegramUserId }],
  });

  const wallet = await privy.wallets().create({
    chain_type: "solana",
    // App-owned wallet: the authorization key is the owner, so signing and export
    // both work server-side without requiring a user JWT.
    // biome-ignore lint/suspicious/noExplicitAny: Privy SDK owner field not typed for app-owned wallets
    owner: { public_key: getAppPublicKey() } as any,
  });

  return {
    privyUserId: user.id,
    privyWalletId: wallet.id,
    walletAddress: wallet.address,
  };
}

/**
 * Returns the Privy wallet UUID for a given wallet address.
 * The ID is persisted at wallet-creation time, so a missing value indicates an
 * inconsistent DB row (no on-the-fly backfill).
 */
export async function resolvePrivyWalletId(walletAddress: string): Promise<string> {
  const user = await db.query.users.findFirst({
    where: eq(users.walletAddress, walletAddress),
    columns: { privyWalletId: true },
  });
  if (!user) throw new Error(`No user found for wallet address ${walletAddress}`);
  if (!user.privyWalletId) {
    throw new Error(
      `Wallet not initialized for ${walletAddress} — missing privyWalletId. Account may be corrupted; contact support.`,
    );
  }
  return user.privyWalletId;
}

export async function getPrivyKitSigner(walletAddress: string): Promise<SolanaKitSigner> {
  const walletId = await resolvePrivyWalletId(walletAddress);

  return createSolanaKitSigner(privy, {
    walletId,
    address: walletAddress as Address,
    authorizationContext: {
      authorization_private_keys: [config.PRIVY_AUTHORIZATION_PRIVATE_KEY],
    },
  });
}
