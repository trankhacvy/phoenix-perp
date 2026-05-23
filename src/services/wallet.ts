import { type KeyPairSigner, createKeyPairSignerFromBytes } from "@solana/signers";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config/index.js";
import { privy } from "../lib/privy.js";

let _testSigner: KeyPairSigner | null = null;

/** Call once at startup to wire TEST_KEYPAIR into getKitSigner. Idempotent. */
export async function initTestSigner(): Promise<string> {
  if (_testSigner) return _testSigner.address as string;
  const raw = config.TEST_KEYPAIR;
  if (!raw) throw new Error("TEST_KEYPAIR env var not set");
  const bytes = bs58.decode(raw);
  _testSigner = await createKeyPairSignerFromBytes(bytes);
  return _testSigner.address as string;
}

export async function createEmbeddedWallet(telegramUserId: string) {
  // Step 1: create Privy user linked to Telegram identity
  const user = await privy.importUser({
    linkedAccounts: [{ type: "telegram", telegramUserId }],
  });

  // Step 2: create Solana wallet owned by user, with bot as authorized signer so
  // the server can sign transactions on the user's behalf without user presence.
  const wallet = await privy.walletApi.createWallet({
    chainType: "solana",
    owner: { userId: user.id },
    ...(config.PRIVY_AUTHORIZATION_KEY_ID && {
      additionalSigners: [{ signerId: config.PRIVY_AUTHORIZATION_KEY_ID }],
    }),
  });

  return { privyUserId: user.id, walletAddress: wallet.address };
}

export function getWalletSigner(walletAddress: string) {
  return async (
    transaction: Transaction | VersionedTransaction,
  ): Promise<Transaction | VersionedTransaction> => {
    const { signedTransaction } = await privy.walletApi.solana.signTransaction({
      address: walletAddress,
      chainType: "solana",
      transaction,
    });
    return signedTransaction;
  };
}

// TODO: implement Privy → @solana/kit signer bridge; see scripts/test-onchain.ts for on-chain testing
export function getKitSigner(_walletAddress: string): KeyPairSigner {
  if (_testSigner) return _testSigner;
  throw new Error(
    "Privy → @solana/kit signer bridge not yet implemented. " +
      "Call initTestSigner() first (test scripts) or implement the Privy adapter.",
  );
}

