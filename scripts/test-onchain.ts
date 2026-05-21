/**
 * Standalone on-chain test script — no Telegram, no DB, no Redis.
 *
 * Usage:
 *   npx tsx scripts/test-onchain.ts
 *
 * Required env vars:
 *   HELIUS_RPC_URL        your Helius RPC endpoint
 *   TEST_KEYPAIR          base58-encoded 64-byte secret key
 *   BUILDER_ACCESS_CODE   Phoenix builder access code
 *   PHOENIX_API_URL       (default: https://perp-api.phoenix.trade)
 *
 * Flow: snapshot SOL balance → open long → wait 5s → close → show SOL diff
 */

import "dotenv/config";
import bs58 from "bs58";
import {
  createPhoenixClient,
  Side,
  OrderFlags,
  SelfTradeBehavior,
  baseLots,
  quoteLots,
  symbol as riseSymbol,
  type Authority,
  type ImmediateOrCancelOrderPacket,
} from "@ellipsis-labs/rise";
import {
  createKeyPairSignerFromBytes,
  addSignersToInstruction,
  signTransactionMessageWithSigners,
} from "@solana/signers";
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PHOENIX_API_URL =
  process.env.PHOENIX_API_URL ?? "https://perp-api.phoenix.trade";
const RPC_URL =
  process.env.HELIUS_RPC_URL ??
  (() => {
    throw new Error("Set HELIUS_RPC_URL");
  })();
const BUILDER_ACCESS_CODE =
  process.env.BUILDER_ACCESS_CODE ??
  (() => {
    throw new Error("Set BUILDER_ACCESS_CODE");
  })();

const SYMBOL = "SOL";
const TEST_BASE_UNITS = "1";

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function loadKeypair(): Uint8Array {
  const raw = process.env.TEST_KEYPAIR;
  if (!raw) throw new Error("Set TEST_KEYPAIR=<base58-secret-key>");
  const bytes = bs58.decode(raw);
  if (bytes.length !== 64)
    throw new Error(`Expected 64-byte secret key, got ${bytes.length}`);
  return bytes;
}

function makeRpcClients(rpcUrl: string) {
  const wsUrl = rpcUrl
    .replace("https://", "wss://")
    .replace("http://", "ws://");
  return {
    rpc: createSolanaRpc(rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl),
  };
}

async function sendIx(
  ix: Parameters<typeof addSignersToInstruction>[1],
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
): Promise<string> {
  const { rpc, rpcSubscriptions } = makeRpcClients(RPC_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });
  const latestBlockhash = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const signedIx = addSignersToInstruction([signer], ix);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(latestBlockhash.value, tx),
    (tx) => appendTransactionMessageInstructions([signedIx], tx),
  );
  const signedTx = await signTransactionMessageWithSigners(message);
  await sendAndConfirm(
    {
      ...signedTx,
      lifetimeConstraint: {
        lastValidBlockHeight: latestBlockhash.value.lastValidBlockHeight,
      },
    },
    { commitment: "confirmed" },
  );
  return getSignatureFromTransaction(signedTx);
}

function log(step: string, data?: unknown) {
  console.log(`\n[${step}]`);
  if (data !== undefined)
    console.log(
      JSON.stringify(
        data,
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ),
    );
}

async function activateTrader(walletAddress: string): Promise<void> {
  const res = await fetch(`${PHOENIX_API_URL}/v1/invite/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authority: walletAddress,
      code: BUILDER_ACCESS_CODE,
    }),
  });
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    throw new Error(`Activation failed (${res.status}): ${body}`);
  }
  console.log(
    res.status === 409 ? "  Already activated" : "  Activated successfully",
  );
}

async function getSolBalance(walletAddress: string): Promise<bigint> {
  const { rpc } = makeRpcClients(RPC_URL);
  const result = await rpc
    .getBalance(walletAddress as Parameters<typeof rpc.getBalance>[0], {
      commitment: "confirmed",
    })
    .send();
  return result.value;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const keypairBytes = loadKeypair();
  const signer = await createKeyPairSignerFromBytes(keypairBytes);
  const walletAddress = signer.address;
  log("Wallet", { address: walletAddress });

  const client = createPhoenixClient({
    apiUrl: PHOENIX_API_URL,
    rpcUrl: RPC_URL,
    exchangeMetadata: { stream: false },
  });

  try {
    // ── 1. Market data ───────────────────────────────────────────────────────
    log("1. Market data");
    const http = (client.api.markets() as any).http;
    const market = await http.markets().getMarket(SYMBOL);
    const orderbook = (await http.orderbook().getOrderbook(SYMBOL)) as {
      mid: number;
    };
    const markPrice = orderbook.mid;
    log("Market snapshot", {
      symbol: SYMBOL,
      markPrice,
      tickSize: market.tickSize,
    });

    // ── 2. Activate (no-op if done) ──────────────────────────────────────────
    log("2. Activate trader");
    await activateTrader(walletAddress);

    // ── 3. Load exchange metadata ────────────────────────────────────────────
    log("3. Loading exchange metadata");
    await client.exchange.ready();

    // ── 4. Snapshot SOL balance ──────────────────────────────────────────────
    const solBefore = await getSolBalance(walletAddress);
    log("4. SOL balance (before)", {
      lamports: solBefore.toString(),
      sol: (Number(solBefore) / 1e9).toFixed(9),
    });

    // ── 5. Loop: open → wait 5s → close → wait 3s ───────────────────────────
    const TOTAL_ROUNDS = 50;
    for (let round = 1; round <= TOTAL_ROUNDS; round++) {
      log(`5. Round ${round}/${TOTAL_ROUNDS} — opening LONG ${TEST_BASE_UNITS} SOL`);

      const openPacket = await client.ixs.orderPackets.buildMarketOrderPacket({
        symbol: riseSymbol(SYMBOL),
        side: Side.Bid,
        baseUnits: TEST_BASE_UNITS,
      });
      const openIx = await client.ixs.placeMarketOrder({
        authority: walletAddress as Authority,
        symbol: riseSymbol(SYMBOL),
        orderPacket: openPacket,
      });
      const openSig = await sendIx(openIx, signer);
      log(`  Opened`, { signature: openSig, explorer: `https://solscan.io/tx/${openSig}` });

      console.log("  Waiting 5s...");
      await new Promise((r) => setTimeout(r, 5000));

      // Read position lots
      const snapshot = (await http.traders().getTraderStateSnapshot(walletAddress, { traderPdaIndex: 0 })) as {
        snapshot?: {
          subaccounts?: {
            positions?: { symbol: string; basePositionLots: string | number }[];
          }[];
        };
      };
      const positions = snapshot.snapshot?.subaccounts?.flatMap((sa) => sa.positions ?? []) ?? [];
      const pos = positions.find((p) => p.symbol === SYMBOL || p.symbol === `${SYMBOL}-PERP`);
      if (!pos) {
        log("  No open position — order may not have filled, skipping close");
        if (round < TOTAL_ROUNDS) {
          console.log("  Waiting 3s before next round...");
          await new Promise((r) => setTimeout(r, 3000));
        }
        continue;
      }

      const rawLots = Number(pos.basePositionLots);
      const isLong = rawLots > 0;
      const closeLots = BigInt(Math.round(Math.abs(rawLots)));

      const closePacket: ImmediateOrCancelOrderPacket = {
        side: isLong ? Side.Ask : Side.Bid,
        priceInTicks: null,
        numBaseLots: baseLots(closeLots),
        numQuoteLots: null,
        minBaseLotsToFill: baseLots(1n),
        minQuoteLotsToFill: quoteLots(1n),
        selfTradeBehavior: SelfTradeBehavior.Abort,
        matchLimit: null,
        clientOrderId: 0n,
        lastValidSlot: null,
        orderFlags: OrderFlags.ReduceOnly,
        cancelExisting: false,
      };
      const closeIx = await client.ixs.placeMarketOrder({
        authority: walletAddress as Authority,
        symbol: riseSymbol(SYMBOL),
        orderPacket: closePacket,
      });
      const closeSig = await sendIx(closeIx, signer);
      log(`  Closed`, { signature: closeSig, explorer: `https://solscan.io/tx/${closeSig}` });

      if (round < TOTAL_ROUNDS) {
        console.log("  Waiting 3s before next round...");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    // ── 6. SOL diff ──────────────────────────────────────────────────────────
    const solAfter = await getSolBalance(walletAddress);
    const diffLamports = Number(solAfter) - Number(solBefore);
    log("6. SOL balance change (all rounds)", {
      before: (Number(solBefore) / 1e9).toFixed(9) + " SOL",
      after: (Number(solAfter) / 1e9).toFixed(9) + " SOL",
      diff: (diffLamports / 1e9).toFixed(9) + " SOL",
      diffLamports,
    });
  } catch (e) {
    console.error(e);
  } finally {
    client.dispose();
  }
}

main().catch((err) => {
  console.error("\n[FAILED]", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
