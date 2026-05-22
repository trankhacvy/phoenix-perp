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
import {
  type KeyPairSigner,
  addSignersToInstruction,
  signTransactionMessageWithSigners,
} from "@solana/signers";
import { config } from "../../config/index.js";
import { getTradingClient } from "./client.js";
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

export interface TpSlParams {
  symbol: string;
  walletAddress: string;
  positionSide: "long" | "short";
  tpPrice?: number;
  slPrice?: number;
  slMode?: "market" | "limit";
  tpMode?: "market" | "limit";
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

type AnyInstruction = Parameters<typeof addSignersToInstruction>[1];

let _rpc: ReturnType<typeof createSolanaRpc> | null = null;
let _sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory> | null = null;

function getRpc() {
  if (!_rpc) {
    const rpcUrl = config.HELIUS_RPC_URL;
    const wsUrl = rpcUrl.replace("https://", "wss://").replace("http://", "ws://");
    _rpc = createSolanaRpc(rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
    _sendAndConfirm = sendAndConfirmTransactionFactory({ rpc: _rpc, rpcSubscriptions });
  }
  return { rpc: _rpc, sendAndConfirm: _sendAndConfirm! };
}

async function sendInstruction(ix: AnyInstruction, signer: KeyPairSigner): Promise<string> {
  const { rpc, sendAndConfirm } = getRpc();
  const latestBlockhash = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signedIx = addSignersToInstruction([signer], ix);

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash.value, tx),
    (tx) => appendTransactionMessageInstructions([signedIx], tx),
  );

  const signedTx = await signTransactionMessageWithSigners(message);
  await sendAndConfirm(
    {
      ...signedTx,
      lifetimeConstraint: { lastValidBlockHeight: latestBlockhash.value.lastValidBlockHeight },
    },
    { commitment: "confirmed" },
  );
  return getSignatureFromTransaction(signedTx);
}

async function sendInstructions(ixs: AnyInstruction[], signer: KeyPairSigner): Promise<string> {
  const sigs = await Promise.all(ixs.map((ix) => sendInstruction(ix, signer)));
  return sigs[sigs.length - 1] ?? "";
}

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

export async function placeMarketOrder(
  params: MarketOrderParams,
  signer: KeyPairSigner,
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

  return sendInstruction(ix, signer);
}

export async function placeLimitOrder(
  params: LimitOrderParams,
  signer: KeyPairSigner,
): Promise<string> {
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

  return sendInstruction(ix, signer);
}

export async function setTpSl(params: TpSlParams, signer: KeyPairSigner): Promise<void> {
  const client = getTradingClient();
  await client.exchange.ready();

  const marketSymbol = toMarketSymbol(params.symbol);
  const market = (await getMarket(params.symbol)) as { tickSize: number; baseLotsDecimals: number };
  const closeSide = params.positionSide === "long" ? Side.Ask : Side.Bid;

  const sends: Promise<string>[] = [];

  if (params.slPrice !== undefined) {
    const triggerTicks = priceToTicks(params.slPrice, market);
    const ix = await client.ixs.buildPlaceStopLoss({
      authority: params.walletAddress as Authority,
      symbol: marketSymbol,
      tradeSide: closeSide,
      executionDirection:
        params.positionSide === "long" ? Direction.LessThan : Direction.GreaterThan,
      orderKind: params.slMode === "limit" ? StopLossOrderKind.Limit : StopLossOrderKind.IOC,
      triggerPrice: triggerTicks,
    });
    sends.push(sendInstruction(ix, signer));
  }

  if (params.tpPrice !== undefined) {
    const triggerTicks = priceToTicks(params.tpPrice, market);
    const ix = await client.ixs.buildPlaceStopLoss({
      authority: params.walletAddress as Authority,
      symbol: marketSymbol,
      tradeSide: closeSide,
      executionDirection:
        params.positionSide === "long" ? Direction.GreaterThan : Direction.LessThan,
      orderKind: params.tpMode === "limit" ? StopLossOrderKind.Limit : StopLossOrderKind.IOC,
      triggerPrice: triggerTicks,
    });
    sends.push(sendInstruction(ix, signer));
  }

  await Promise.all(sends);
}

export async function closePosition(
  symbol: string,
  walletAddress: string,
  signer: KeyPairSigner,
  fraction = 1,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const marketSymbol = toMarketSymbol(symbol);

  const snapshot = (await getTraderStateSnapshot(walletAddress)) as unknown as {
    snapshot?: { subaccounts?: { positions?: { symbol: string; basePositionLots: string }[] }[] };
  };

  const subaccounts = snapshot.snapshot?.subaccounts ?? [];
  const allPositions = subaccounts.flatMap((sa) => sa.positions ?? []);
  const pos = allPositions.find(
    (p) => p.symbol === String(marketSymbol) || p.symbol === symbol.toUpperCase(),
  );
  if (!pos) throw new Error(`No open position for ${symbol}`);

  const rawLots = Number(pos.basePositionLots);
  const isLong = rawLots > 0;
  const closeLots = BigInt(Math.round(Math.abs(rawLots) * fraction));
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

  return sendInstruction(ix, signer);
}

export async function cancelStopLoss(
  symbol: string,
  walletAddress: string,
  direction: "long_sl" | "long_tp" | "short_sl" | "short_tp",
  signer: KeyPairSigner,
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

  return sendInstruction(ix, signer);
}

export async function addMargin(
  _symbol: string,
  walletAddress: string,
  amountUsdc: number,
  signer: KeyPairSigner,
): Promise<string> {
  const amountNative = BigInt(Math.round(amountUsdc * 1_000_000));
  return depositCollateral(walletAddress, amountNative, signer);
}

export async function depositCollateral(
  walletAddress: string,
  amountUsdcNative: bigint,
  signer: KeyPairSigner,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const result = await client.ixs.buildDepositIxs({
    authority: walletAddress as Authority,
    amount: amountUsdcNative,
    traderPdaIndex: 0,
  });

  return sendInstructions(result.instructions, signer);
}

export async function withdrawCollateral(
  walletAddress: string,
  amountUsdcNative: bigint,
  signer: KeyPairSigner,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  const result = await client.ixs.buildWithdrawIxs({
    authority: walletAddress as Authority,
    amount: amountUsdcNative,
    traderPdaIndex: 0,
  });

  return sendInstructions(result.instructions, signer);
}
