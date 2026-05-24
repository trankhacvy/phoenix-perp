import {
  type Authority,
  Direction,
  type ImmediateOrCancelOrderPacket,
  OrderFlags,
  SelfTradeBehavior,
  Side,
  StopLossOrderKind,
  baseLots,
  priceUsdToTicks,
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
import { getKitSigner, getPrivyKitSigner } from "../wallet.js";
import { getTradingClient } from "./client.js";
import { fractionToCloseLots } from "./lots.js";
import { getMarket } from "./market.js";
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

export interface TpSlLevel {
  price: number;
  fraction?: number;
  mode?: "market" | "limit";
}

export interface TpSlParams {
  symbol: string;
  walletAddress: string;
  positionSide: "long" | "short";
  tpPrice?: number;
  slPrice?: number;
  slMode?: "market" | "limit";
  tpMode?: "market" | "limit";
  tpLevels?: TpSlLevel[];
  slLevels?: TpSlLevel[];
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

type AnyInstruction = Parameters<typeof addSignersToInstruction>[1];

const JITO_TIP_LAMPORTS = 200_000n;
const COMPUTE_UNIT_PRICE = 200_000;
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

type LatestBlockhashValue = Awaited<
  ReturnType<ReturnType<ReturnType<typeof createSolanaRpc>["getLatestBlockhash"]>["send"]>
>["value"];

let _cachedBlockhash: {
  value: LatestBlockhashValue;
  fetchedAt: number;
} | null = null;
const BLOCKHASH_TTL_MS = 20_000;

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

async function pollConfirmation(signature: string): Promise<void> {
  const rpc = getRpc();
  const latestBlockhash = await getBlockhash();
  const deadline = Number(latestBlockhash.lastValidBlockHeight);
  const sig = signature as Parameters<typeof rpc.getSignatureStatuses>[0][number];

  for (let attempts = 0; attempts < 60; attempts++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const status = value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      if (status.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
      return;
    }
    const slotRes = await rpc.getSlot({ commitment: "confirmed" }).send();
    if (Number(slotRes) > deadline) {
      throw new Error(`Transaction expired before confirmation (signature: ${signature})`);
    }
  }
  throw new Error(`Timed out waiting for confirmation (signature: ${signature})`);
}

async function sendInstruction(
  ix: AnyInstruction,
  signer: TransactionPartialSigner,
): Promise<string> {
  const latestBlockhash = await getBlockhash();
  const tipAccount = JITO_TIP_ACCOUNTS[
    Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)
  ] as Address;

  // Attach signer to the Rise SDK instruction accounts before appending.
  const signedIx = addSignersToInstruction([signer], ix);

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitPriceInstruction({
            microLamports: COMPUTE_UNIT_PRICE,
          }),
          getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
          signedIx,
          getTransferSolInstruction({
            source: signer,
            destination: tipAccount,
            amount: lamports(JITO_TIP_LAMPORTS),
          }),
        ],
        tx,
      ),
  );

  const signedTx = await signTransactionMessageWithSigners(message);
  const txBytes = getTransactionEncoder().encode(signedTx);
  const sig = await sendViaHeliusSender(Buffer.from(txBytes).toString("base64"));
  await pollConfirmation(sig);
  return sig;
}

async function getSigner(walletAddress: string): Promise<TransactionPartialSigner> {
  if (config.TEST_KEYPAIR) return getKitSigner(walletAddress);
  return getPrivyKitSigner(walletAddress);
}

async function dispatchInstruction(ix: AnyInstruction, walletAddress: string): Promise<string> {
  const signer = await getSigner(walletAddress);
  return sendInstruction(ix, signer);
}

async function dispatchInstructions(ixs: AnyInstruction[], walletAddress: string): Promise<string> {
  if (ixs.length === 0) throw new Error("No instructions to dispatch");
  if (ixs.length === 1) return dispatchInstruction(ixs[0], walletAddress);

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
          getSetComputeUnitPriceInstruction({ microLamports: COMPUTE_UNIT_PRICE }),
          getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
          ...signedIxs,
          getTransferSolInstruction({
            source: signer,
            destination: tipAccount,
            amount: lamports(JITO_TIP_LAMPORTS),
          }),
        ],
        tx,
      ),
  );

  const signedTx = await signTransactionMessageWithSigners(message);
  const txBytes = getTransactionEncoder().encode(signedTx);
  const sig = await sendViaHeliusSender(Buffer.from(txBytes).toString("base64"));
  await pollConfirmation(sig);
  return sig;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function toMarketSymbol(s: string) {
  return riseSymbol(s.toUpperCase().replace(/-PERP$/i, ""));
}

function priceToTicks(
  priceUsd: number,
  market: { tickSize: number; baseLotsDecimals: number },
): bigint {
  return BigInt(
    priceUsdToTicks(priceUsd, {
      tickSizeInQuoteLotsPerBaseLot: market.tickSize,
      baseLotsDecimals: market.baseLotsDecimals,
    }),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export async function placeMarketOrder(params: MarketOrderParams): Promise<string> {
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

  return dispatchInstruction(ix, params.walletAddress);
}

export async function placeLimitOrder(params: LimitOrderParams): Promise<string> {
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

  return dispatchInstruction(ix, params.walletAddress);
}

export async function setTpSl(params: TpSlParams): Promise<void> {
  const client = getTradingClient();
  await client.exchange.ready();

  const marketSymbol = toMarketSymbol(params.symbol);
  const market = (await getMarket(params.symbol)) as {
    tickSize: number;
    baseLotsDecimals: number;
  };
  const closeSide = params.positionSide === "long" ? Side.Ask : Side.Bid;

  const tpLevels: TpSlLevel[] = params.tpLevels?.length
    ? params.tpLevels
    : params.tpPrice !== undefined
      ? [{ price: params.tpPrice, mode: params.tpMode ?? "limit" }]
      : [];

  const slLevels: TpSlLevel[] = params.slLevels?.length
    ? params.slLevels
    : params.slPrice !== undefined
      ? [{ price: params.slPrice, mode: params.slMode ?? "market" }]
      : [];

  const ixs: AnyInstruction[] = [];

  // TODO(ladder-fractions): `level.fraction` is ignored — every rung becomes a
  // full-position close. `buildPlaceStopLoss` doesn't accept size; switch to
  // `buildPlacePositionConditionalOrder` (sizeBaseLots/sizePercent) to fix.
  for (const level of tpLevels) {
    const triggerTicks = priceToTicks(level.price, market);
    ixs.push(
      await client.ixs.buildPlaceStopLoss({
        authority: params.walletAddress as Authority,
        symbol: marketSymbol,
        tradeSide: closeSide,
        executionDirection:
          params.positionSide === "long" ? Direction.GreaterThan : Direction.LessThan,
        orderKind:
          (level.mode ?? "limit") === "limit" ? StopLossOrderKind.Limit : StopLossOrderKind.IOC,
        triggerPrice: triggerTicks,
      }),
    );
  }

  for (const level of slLevels) {
    const triggerTicks = priceToTicks(level.price, market);
    ixs.push(
      await client.ixs.buildPlaceStopLoss({
        authority: params.walletAddress as Authority,
        symbol: marketSymbol,
        tradeSide: closeSide,
        executionDirection:
          params.positionSide === "long" ? Direction.LessThan : Direction.GreaterThan,
        orderKind:
          (level.mode ?? "market") === "limit" ? StopLossOrderKind.Limit : StopLossOrderKind.IOC,
        triggerPrice: triggerTicks,
      }),
    );
  }

  for (const ix of ixs) {
    await dispatchInstruction(ix, params.walletAddress);
  }
}

export async function closePosition(
  symbol: string,
  walletAddress: string,
  fraction = 1,
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

  return dispatchInstruction(ix, walletAddress);
}

export async function cancelStopLoss(
  symbol: string,
  walletAddress: string,
  direction: "long_sl" | "long_tp" | "short_sl" | "short_tp",
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const marketSymbol = toMarketSymbol(symbol);
  const executionDirection =
    direction === "long_sl" || direction === "short_tp"
      ? Direction.LessThan
      : Direction.GreaterThan;

  const ix = await client.ixs.buildCancelStopLoss({
    authority: walletAddress as Authority,
    symbol: marketSymbol,
    executionDirection,
  });

  return dispatchInstruction(ix, walletAddress);
}

export async function addMargin(
  _symbol: string,
  walletAddress: string,
  amountUsdc: number,
): Promise<string> {
  const amountNative = BigInt(Math.round(amountUsdc * 1_000_000));
  return depositCollateral(walletAddress, amountNative);
}

export async function depositCollateral(
  walletAddress: string,
  amountUsdcNative: bigint,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const result = await client.ixs.buildDepositIxs({
    authority: walletAddress as Authority,
    amount: amountUsdcNative,
    traderPdaIndex: 0,
  });

  return dispatchInstructions(result.instructions, walletAddress);
}

export async function withdrawCollateral(
  walletAddress: string,
  amountUsdcNative: bigint,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const result = await client.ixs.buildWithdrawIxs({
    authority: walletAddress as Authority,
    amount: amountUsdcNative,
    traderPdaIndex: 0,
  });

  return dispatchInstructions(result.instructions, walletAddress);
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const USDC_DECIMALS = 6;

export async function transferUsdc(
  fromAddress: string,
  toAddress: string,
  amountNative: bigint,
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

  return dispatchInstructions([createAtaIx, transferIx], fromAddress);
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
