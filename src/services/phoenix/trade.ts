import {
  type Authority,
  type ImmediateOrCancelOrderPacket,
  OrderFlags,
  SelfTradeBehavior,
  Side,
  baseLots,
  quoteLots,
  symbol as riseSymbol,
} from "@ellipsis-labs/rise";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import {
  type Address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  type TransactionPartialSigner,
  addSignersToInstruction,
  signTransactionMessageWithSigners,
} from "@solana/signers";
import { config } from "../../config/index.js";
import { getPrivyKitSigner } from "../wallet.js";
import { getTradingClient } from "./client.js";
import { fractionToCloseLots } from "./lots.js";
import { getTraderStateSnapshot } from "./position.js";

export interface MarketOrderParams {
  symbol: string;
  side: "long" | "short";
  /** Size in base token units, e.g. "0.25" for 0.25 SOL */
  baseUnits: string;
  walletAddress: string;
}

export interface LimitOrderParams {
  symbol: string;
  side: "long" | "short";
  baseUnits: string;
  priceUsd: string;
  walletAddress: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

type AnyInstruction = Parameters<typeof addSignersToInstruction>[1];

export interface FeeConfig {
  tipLamports: bigint;
  cuPrice: number;
}

const FEE_PRESETS: Record<string, FeeConfig> = {
  eco: { tipLamports: 600_000n, cuPrice: 100_000 },
  normal: { tipLamports: 1_500_000n, cuPrice: 200_000 },
  turbo: { tipLamports: 7_500_000n, cuPrice: 1_000_000 },
};

const DEFAULT_FEE: FeeConfig = FEE_PRESETS.normal;

export function getFeeConfig(mode: string, customSol?: number | null): FeeConfig {
  if (mode === "custom" && customSol && customSol > 0) {
    const tipLamports = BigInt(Math.round(customSol * 1e9));
    const cuPrice = Math.max(Math.round((customSol * 1e15) / 250_000), 10_000);
    return { tipLamports, cuPrice };
  }
  return FEE_PRESETS[mode] ?? DEFAULT_FEE;
}

const COMPUTE_UNIT_LIMIT = 250_000;
const JITO_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
] as const;

let _rpc: ReturnType<typeof createSolanaRpc> | null = null;

function getRpc() {
  if (!_rpc) _rpc = createSolanaRpc(config.HELIUS_RPC_URL);
  return _rpc;
}

const _solCache = new Map<string, { balance: bigint; fetchedAt: number }>();
const SOL_CACHE_TTL_MS = 30_000;
const MIN_SOL_LAMPORTS = 5_000_000n; // 0.005 SOL — covers eco + normal fees with buffer

async function getSolBalanceCached(walletAddress: string): Promise<bigint> {
  const now = Date.now();
  const cached = _solCache.get(walletAddress);
  if (cached && now - cached.fetchedAt < SOL_CACHE_TTL_MS) return cached.balance;
  const result = await getRpc()
    .getBalance(walletAddress as Address, { commitment: "confirmed" })
    .send();
  const balance = BigInt(result.value);
  _solCache.set(walletAddress, { balance, fetchedAt: now });
  return balance;
}

async function checkSolPreflight(walletAddress: string): Promise<void> {
  const balance = await getSolBalanceCached(walletAddress);
  if (balance < MIN_SOL_LAMPORTS) {
    throw new Error(
      `Insufficient SOL for fees: wallet has ${balance} lamports (need at least ${MIN_SOL_LAMPORTS})`,
    );
  }
}

type LatestBlockhashValue = Awaited<
  ReturnType<ReturnType<ReturnType<typeof createSolanaRpc>["getLatestBlockhash"]>["send"]>
>["value"];

let _cachedBlockhash: {
  value: LatestBlockhashValue;
  fetchedAt: number;
} | null = null;
const BLOCKHASH_TTL_MS = 10_000;

async function getBlockhash(): Promise<LatestBlockhashValue> {
  const now = Date.now();
  if (_cachedBlockhash && now - _cachedBlockhash.fetchedAt < BLOCKHASH_TTL_MS) {
    return _cachedBlockhash.value;
  }
  const result = await getRpc().getLatestBlockhash({ commitment: "confirmed" }).send();
  _cachedBlockhash = { value: result.value, fetchedAt: now };
  return result.value;
}

let _heliusSenderUrl: string | null = null;
function getHeliusSenderUrl(): string {
  if (_heliusSenderUrl) return _heliusSenderUrl;
  try {
    const url = new URL(config.HELIUS_RPC_URL);
    const apiKey = url.searchParams.get("api-key");
    _heliusSenderUrl = `https://sender.helius-rpc.com/fast${apiKey ? `?api-key=${apiKey}` : ""}`;
  } catch {
    _heliusSenderUrl = "https://sender.helius-rpc.com/fast";
  }
  return _heliusSenderUrl;
}

async function sendViaHeliusSender(base64Tx: string): Promise<string> {
  const res = await fetch(getHeliusSenderUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [base64Tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
    }),
  });
  if (!res.ok) throw new Error(`Helius Sender HTTP error: ${res.status}`);
  const json = (await res.json()) as {
    result?: string;
    error?: { message: string };
  };
  if (json.error) throw new Error(`Helius Sender: ${json.error.message}`);
  if (!json.result) throw new Error("Helius Sender: no signature in response");
  return json.result;
}

async function pollConfirmation(
  signature: string,
  blockhash?: LatestBlockhashValue,
): Promise<void> {
  const rpc = getRpc();
  const bh = blockhash ?? (await getBlockhash());
  const deadline = Number(bh.lastValidBlockHeight);
  const sig = signature as Parameters<typeof rpc.getSignatureStatuses>[0][number];

  for (let attempts = 0; attempts < 60; attempts++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const status = value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      if (status.err)
        throw new Error(
          `Transaction failed on-chain: ${JSON.stringify(status.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
        );
      return;
    }
    const slotRes = await rpc.getSlot({ commitment: "confirmed" }).send();
    if (Number(slotRes) > deadline) {
      throw new Error(`Transaction expired before confirmation (signature: ${signature})`);
    }
  }
  throw new Error(`Transaction status unknown — timed out polling. Check Solscan: ${signature}`);
}

async function sendInstruction(
  ix: AnyInstruction,
  signer: TransactionPartialSigner,
  fee: FeeConfig = DEFAULT_FEE,
): Promise<string> {
  const walletAddress = signer.address as string;
  await checkSolPreflight(walletAddress);
  const latestBlockhash = await getBlockhash();
  const tipAccount = JITO_TIP_ACCOUNTS[
    Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)
  ] as Address;

  const signedIx = addSignersToInstruction([signer], ix);

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitPriceInstruction({
            microLamports: fee.cuPrice,
          }),
          getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
          signedIx,
          getTransferSolInstruction({
            source: signer,
            destination: tipAccount,
            amount: lamports(fee.tipLamports),
          }),
        ],
        tx,
      ),
  );

  const signedTx = await signTransactionMessageWithSigners(message);
  const txBytes = getTransactionEncoder().encode(signedTx);
  let sig: string;
  try {
    sig = await sendViaHeliusSender(Buffer.from(txBytes).toString("base64"));
  } finally {
    _cachedBlockhash = null;
    _solCache.delete(walletAddress);
  }
  await pollConfirmation(sig, latestBlockhash);
  return sig;
}

async function getSigner(walletAddress: string): Promise<TransactionPartialSigner> {
  return getPrivyKitSigner(walletAddress);
}

async function dispatchInstruction(
  ix: AnyInstruction,
  walletAddress: string,
  fee: FeeConfig = DEFAULT_FEE,
): Promise<string> {
  const signer = await getSigner(walletAddress);
  return sendInstruction(ix, signer, fee);
}

async function dispatchInstructions(
  ixs: AnyInstruction[],
  walletAddress: string,
  fee: FeeConfig = DEFAULT_FEE,
): Promise<string> {
  if (ixs.length === 0) throw new Error("No instructions to dispatch");
  if (ixs.length === 1) return dispatchInstruction(ixs[0], walletAddress, fee);

  await checkSolPreflight(walletAddress);
  const signer = await getSigner(walletAddress);
  const latestBlockhash = await getBlockhash();
  const tipAccount = JITO_TIP_ACCOUNTS[
    Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)
  ] as Address;

  const signedIxs = ixs.map((ix) => addSignersToInstruction([signer], ix));

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitPriceInstruction({ microLamports: fee.cuPrice }),
          getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
          ...signedIxs,
          getTransferSolInstruction({
            source: signer,
            destination: tipAccount,
            amount: lamports(fee.tipLamports),
          }),
        ],
        tx,
      ),
  );

  const signedTx = await signTransactionMessageWithSigners(message);
  const txBytes = getTransactionEncoder().encode(signedTx);
  let sig: string;
  try {
    sig = await sendViaHeliusSender(Buffer.from(txBytes).toString("base64"));
  } finally {
    _cachedBlockhash = null;
    _solCache.delete(walletAddress);
  }
  await pollConfirmation(sig, latestBlockhash);
  return sig;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function toMarketSymbol(s: string) {
  return riseSymbol(s.toUpperCase().replace(/-PERP$/i, ""));
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export async function placeMarketOrder(
  params: MarketOrderParams,
  fee?: FeeConfig,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const marketSymbol = toMarketSymbol(params.symbol);
  const orderPacket = await client.ixs.orderPackets.buildMarketOrderPacket({
    symbol: marketSymbol,
    side: params.side === "long" ? Side.Bid : Side.Ask,
    baseUnits: params.baseUnits,
  });

  const ix = await client.ixs.placeMarketOrder({
    authority: params.walletAddress as Authority,
    symbol: marketSymbol,
    orderPacket,
  });

  return dispatchInstruction(ix, params.walletAddress, fee);
}

export async function placeLimitOrder(params: LimitOrderParams, fee?: FeeConfig): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const marketSymbol = toMarketSymbol(params.symbol);
  const orderPacket = await client.ixs.orderPackets.buildLimitOrderPacket({
    symbol: marketSymbol,
    side: params.side === "long" ? Side.Bid : Side.Ask,
    priceUsd: params.priceUsd,
    baseUnits: params.baseUnits,
  });

  const ix = await client.ixs.buildPlaceLimitOrder({
    authority: params.walletAddress as Authority,
    symbol: marketSymbol,
    orderPacket,
    traderPdaIndex: 0,
  });

  return dispatchInstruction(ix, params.walletAddress, fee);
}

export async function setPositionTpSl(
  params: import("./conditional.js").SetPositionTpSlParams,
  fee?: FeeConfig,
): Promise<string> {
  const { buildSetPositionTpSlIxs, markPdaInitialized } = await import("./conditional.js");
  const { ixs, pdaInitNeeded } = await buildSetPositionTpSlIxs(params);
  const sig = await dispatchInstructions(ixs as AnyInstruction[], params.walletAddress, fee);
  if (pdaInitNeeded) markPdaInitialized(params.walletAddress);
  return sig;
}

export async function cancelPositionConditional(
  walletAddress: string,
  symbol: string,
  positionSide: "long" | "short",
  leg: "tp" | "sl",
  conditionalOrderIndex: number,
  fee?: FeeConfig,
): Promise<string> {
  const { buildCancelIxs } = await import("./conditional.js");
  const ixs = await buildCancelIxs(walletAddress, symbol, positionSide, {
    leg,
    index: conditionalOrderIndex,
  });
  return dispatchInstructions(ixs as AnyInstruction[], walletAddress, fee);
}

export async function cancelAllPositionConditionals(
  walletAddress: string,
  symbol: string,
  positionSide: "long" | "short",
  filter: "tp" | "sl" | "both",
  fee?: FeeConfig,
): Promise<string> {
  const { buildCancelIxs } = await import("./conditional.js");
  const ixs = await buildCancelIxs(walletAddress, symbol, positionSide, filter);
  return dispatchInstructions(ixs as AnyInstruction[], walletAddress, fee);
}

export async function closePosition(
  symbol: string,
  walletAddress: string,
  fraction = 1,
  fee?: FeeConfig,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const marketSymbol = toMarketSymbol(symbol);

  const snapshot = (await getTraderStateSnapshot(walletAddress)) as unknown as {
    snapshot?: {
      subaccounts?: {
        positions?: { symbol: string; basePositionLots: string }[];
      }[];
    };
  };

  const subaccounts = snapshot.snapshot?.subaccounts ?? [];
  const allPositions = subaccounts.flatMap((sa) => sa.positions ?? []);
  const pos = allPositions.find(
    (p) => p.symbol === String(marketSymbol) || p.symbol === symbol.toUpperCase(),
  );
  if (!pos) throw new Error(`No open position for ${symbol}`);

  const rawLots = Number(pos.basePositionLots);
  const isLong = rawLots > 0;
  const closeLots = fractionToCloseLots(rawLots, fraction);
  const closeSide = isLong ? Side.Ask : Side.Bid;

  const orderPacket: ImmediateOrCancelOrderPacket = {
    side: closeSide,
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

  const ix = await client.ixs.placeMarketOrder({
    authority: walletAddress as Authority,
    symbol: marketSymbol,
    orderPacket,
  });

  return dispatchInstruction(ix, walletAddress, fee);
}

export async function addMargin(
  _symbol: string,
  walletAddress: string,
  amountUsdc: number,
  fee?: FeeConfig,
): Promise<string> {
  const amountNative = BigInt(Math.round(amountUsdc * 1_000_000));
  return depositCollateral(walletAddress, amountNative, fee);
}

export async function depositCollateral(
  walletAddress: string,
  amountUsdcNative: bigint,
  fee?: FeeConfig,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const result = await client.ixs.buildDepositIxs({
    authority: walletAddress as Authority,
    amount: amountUsdcNative,
    traderPdaIndex: 0,
  });

  return dispatchInstructions(result.instructions, walletAddress, fee);
}

export async function withdrawCollateral(
  walletAddress: string,
  amountUsdcNative: bigint,
  fee?: FeeConfig,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const result = await client.ixs.buildWithdrawIxs({
    authority: walletAddress as Authority,
    amount: amountUsdcNative,
    traderPdaIndex: 0,
  });

  return dispatchInstructions(result.instructions, walletAddress, fee);
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const USDC_DECIMALS = 6;

export async function transferUsdc(
  fromAddress: string,
  toAddress: string,
  amountNative: bigint,
  fee?: FeeConfig,
): Promise<string> {
  const signer = await getSigner(fromAddress);
  const from = fromAddress as Address;
  const to = toAddress as Address;

  const [sourceAta] = await findAssociatedTokenPda({
    owner: from,
    mint: USDC_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const [destAta] = await findAssociatedTokenPda({
    owner: to,
    mint: USDC_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
    payer: signer,
    ata: destAta,
    owner: to,
    mint: USDC_MINT,
  });

  const transferIx = getTransferCheckedInstruction({
    source: sourceAta,
    mint: USDC_MINT,
    destination: destAta,
    authority: signer,
    amount: amountNative,
    decimals: USDC_DECIMALS,
  });

  return dispatchInstructions([createAtaIx, transferIx], fromAddress, fee);
}

export async function getUsdcAtaBalanceNative(walletAddress: string): Promise<bigint> {
  const [ata] = await findAssociatedTokenPda({
    owner: walletAddress as Address,
    mint: USDC_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  try {
    const result = await getRpc().getTokenAccountBalance(ata, { commitment: "confirmed" }).send();
    return BigInt(result.value.amount);
  } catch {
    return 0n;
  }
}
