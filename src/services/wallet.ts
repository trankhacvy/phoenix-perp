import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { config } from "../config/index.js";
import { privy } from "../lib/privy.js";

export async function createEmbeddedWallet(telegramUserId: string) {
  const user = await privy.importUser({
    linkedAccounts: [{ type: "telegram", telegramUserId }],
    createSolanaWallet: true,
  });

  const wallet = user.linkedAccounts.find(
    (a): a is typeof a & { type: "wallet"; address: string } =>
      a.type === "wallet" && (a as { chainType?: string }).chainType === "solana",
  );
  if (!wallet) throw new Error("Solana embedded wallet not created by Privy");

  return { privyUserId: user.id, walletAddress: wallet.address };
}

export function getWalletSigner(walletAddress: string) {
  return async (transaction: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction> => {
    const { signedTransaction } = await privy.walletApi.solana.signTransaction({
      address: walletAddress,
      chainType: "solana",
      transaction,
    });
    return signedTransaction;
  };
}

export async function activatePhoenixAccount(walletAddress: string) {
  const res = await fetch(`${config.PHOENIX_API_URL}/v1/invite/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet_address: walletAddress,
      code: config.BUILDER_ACCESS_CODE,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Phoenix activation failed: ${JSON.stringify(err)}`);
  }
}
