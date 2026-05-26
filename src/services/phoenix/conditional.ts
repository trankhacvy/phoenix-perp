import {
  type Authority,
  type BaseLots,
  Direction,
  type ExchangeMarketConfig,
  type InstructionsWithAccountsAndData,
  type PhoenixClient,
  Side,
  StopLossOrderKind,
  type TraderStateConditionalStopLossTrigger,
  type TraderStateConditionalTakeProfitTrigger,
  type TraderStatePositionSnapshot,
  type TraderStateSnapshotResponse,
  baseLots,
  priceUsdToTicks,
  symbol as riseSymbol,
  ticks,
} from "@ellipsis-labs/rise";
import { type Address, createSolanaRpc } from "@solana/kit";
import { BotError } from "../../bot/lib/errors.js";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";
import { withRetry } from "../../lib/retry.js";
import { getPhoenixClient } from "./client.js";
import { getMarket, getMarketSnapshot } from "./market.js";
import { getTraderState } from "./position.js";

export type Leg = "tp" | "sl";
export type ExecMode = "limit" | "market";
export type TriggerDirectionStr = "greater_than" | "less_than";

export type RungSize =
  | { kind: "full" }
  | { kind: "lots"; lots: bigint }
  | { kind: "tokens"; tokens: number }
  | { kind: "percent"; pct: number };

export interface RungInput {
  leg: Leg;
  triggerPrice: number;
  mode: ExecMode;
  size: RungSize;
}

export interface ResolvedRung {
  leg: Leg;
  triggerPrice: number;
  mode: ExecMode;
  sizeLots: bigint;
}

export interface ConditionalRung {
  leg: Leg;
  triggerPrice: number;
  executionPrice: number;
  conditionalOrderIndex: number;
  triggerDirection: TriggerDirectionStr;
  maxSizeLots: bigint;
  fillableSizeLots: bigint;
  filledSizeLots: bigint;
  mode: ExecMode;
  rawId: string;
}

export interface SetPositionTpSlParams {
  symbol: string;
  walletAddress: string;
  positionSide: "long" | "short";
  tp?: RungInput[];
  sl?: RungInput[];
  cancelTpIndices?: number[];
  cancelSlIndices?: number[];
}

interface MarketLike {
  tickSize: number;
  baseLotsDecimals: number;
  assetId: number;
}

interface ParsedTriggerId {
  conditionalOrderIndex: number;
  triggerDirection: TriggerDirectionStr;
}

interface PositionLookup {
  pos: TraderStatePositionSnapshot;
  positionLots: bigint;
  side: "long" | "short";
}

// ── Tick math ───────────────────────────────────────────────────────────────

const QUOTE_DECIMALS = 6;

export function sideOfBaseLots(raw: string): "long" | "short" {
  return raw.trim().startsWith("-") ? "short" : "long";
}

export function ticksToPriceUsd(ticksValue: bigint | string | number, market: MarketLike): number {
  const t = typeof ticksValue === "bigint" ? Number(ticksValue) : Number(ticksValue);
  return t * market.tickSize * 10 ** (market.baseLotsDecimals - QUOTE_DECIMALS);
}

export function priceUsdToTicksBig(priceUsd: number, market: MarketLike): bigint {
  const tickStr = priceUsdToTicks(priceUsd, {
    baseLotsDecimals: market.baseLotsDecimals,
    tickSizeInQuoteLotsPerBaseLot: market.tickSize,
  });
  return BigInt(tickStr);
}

export function computeMarketExecutionTicks(triggerTicks: bigint, closeSide: Side): bigint {
  const num = Number(triggerTicks);
  const mult = closeSide === Side.Ask ? 0.9 : 1.1;
  return BigInt(Math.floor(num * mult));
}

// ── Trigger ID parser ───────────────────────────────────────────────────────

export function parseConditionalId(
  id: string,
  expectLeg: Leg,
  expectAssetId: number,
): ParsedTriggerId | null {
  const parts = id.split("-");
  if (parts.length !== 4) return null;
  const [prefix, assetIdStr, idxStr, dirStr] = parts;
  const expectedPrefix = expectLeg === "tp" ? "ctp" : "csl";
  if (prefix !== expectedPrefix) return null;
  const assetId = Number(assetIdStr);
  const idx = Number(idxStr);
  if (!Number.isInteger(assetId) || assetId !== expectAssetId) return null;
  if (!Number.isInteger(idx) || idx < 0) return null;
  if (dirStr !== "gt" && dirStr !== "lt") return null;
  return {
    conditionalOrderIndex: idx,
    triggerDirection: dirStr === "gt" ? "greater_than" : "less_than",
  };
}

// ── Size resolution ─────────────────────────────────────────────────────────

export function resolveSize(
  size: RungSize,
  positionLots: bigint,
  market: Pick<MarketLike, "baseLotsDecimals">,
): bigint {
  switch (size.kind) {
    case "full":
      return positionLots;
    case "lots":
      return size.lots;
    case "tokens": {
      if (!Number.isFinite(size.tokens) || size.tokens <= 0) return 0n;
      const factor = 10 ** market.baseLotsDecimals;
      return BigInt(Math.floor(size.tokens * factor));
    }
    case "percent": {
      if (!Number.isFinite(size.pct) || size.pct <= 0 || size.pct > 100) return 0n;
      const scaled = Math.floor(size.pct * 100);
      return (positionLots * BigInt(scaled)) / 10_000n;
    }
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

interface PositionForValidation {
  markPrice: string;
  liquidationPrice: string;
}

export function validateTriggerPrice(
  price: number,
  leg: Leg,
  positionSide: "long" | "short",
  pos: PositionForValidation,
): void {
  if (!Number.isFinite(price) || price <= 0) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "Enter a positive price.",
    });
  }
  const mark = Number(pos.markPrice);
  const liq = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);

  if (leg === "tp") {
    if (positionSide === "long" && price <= mark) {
      throw new BotError({
        category: "validation",
        code: "INVALID_INPUT",
        userMessage: `TP for a long must be above current price ($${mark}).`,
      });
    }
    if (positionSide === "short" && price >= mark) {
      throw new BotError({
        category: "validation",
        code: "INVALID_INPUT",
        userMessage: `TP for a short must be below current price ($${mark}).`,
      });
    }
    return;
  }

  // SL
  if (positionSide === "long") {
    if (price >= mark) {
      throw new BotError({
        category: "validation",
        code: "INVALID_INPUT",
        userMessage: `SL for a long must be below current price ($${mark}).`,
      });
    }
    if (liq > 0 && price <= liq) {
      throw new BotError({
        category: "validation",
        code: "INVALID_INPUT",
        userMessage: `SL at $${price} is at/below your liquidation ($${liq}).`,
        hint: `Set an SL above $${liq}.`,
      });
    }
  } else {
    if (price <= mark) {
      throw new BotError({
        category: "validation",
        code: "INVALID_INPUT",
        userMessage: `SL for a short must be above current price ($${mark}).`,
      });
    }
    if (liq > 0 && price >= liq) {
      throw new BotError({
        category: "validation",
        code: "INVALID_INPUT",
        userMessage: `SL at $${price} is at/above your liquidation ($${liq}).`,
      });
    }
  }
}

export function validateMode(mode: string): asserts mode is ExecMode {
  if (mode !== "limit" && mode !== "market") {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "Mode must be limit or market.",
    });
  }
}

export function validateSize(
  size: RungSize,
  positionLots: bigint,
  remainingLots: bigint,
  market: Pick<MarketLike, "baseLotsDecimals">,
): bigint {
  const lots = resolveSize(size, positionLots, market);
  if (lots <= 0n) {
    const minToken = 10 ** -market.baseLotsDecimals;
    throw new BotError({
      category: "validation",
      code: "SIZE_TOO_SMALL",
      userMessage: "Size must be more than 0.",
      hint: `Minimum ~${minToken.toFixed(market.baseLotsDecimals)} tokens.`,
    });
  }
  if (lots > remainingLots) {
    const tokens = Number(remainingLots) * 10 ** -market.baseLotsDecimals;
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: `Exceeds remaining unallocated size (${tokens.toFixed(market.baseLotsDecimals)}).`,
    });
  }
  return lots;
}

export function resolveRungs(
  inputs: RungInput[],
  positionLots: bigint,
  market: Pick<MarketLike, "baseLotsDecimals">,
  positionSide: "long" | "short",
  pos: PositionForValidation,
): ResolvedRung[] {
  if (inputs.length === 0) return [];

  const fullCount = inputs.filter((i) => i.size.kind === "full").length;
  if (inputs.length > 1 && fullCount > 0) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "When using multiple levels on a leg, every level needs an explicit size.",
    });
  }

  return inputs.map((inp) => {
    validateTriggerPrice(inp.triggerPrice, inp.leg, positionSide, pos);
    validateMode(inp.mode);
    const sizeLots = resolveSize(inp.size, positionLots, market);
    if (sizeLots <= 0n) {
      throw new BotError({
        category: "validation",
        code: "SIZE_TOO_SMALL",
        userMessage: `Resolved size is 0 base lots for price ${inp.triggerPrice}.`,
      });
    }
    return { leg: inp.leg, triggerPrice: inp.triggerPrice, mode: inp.mode, sizeLots };
  });
}

export function validateSizes(
  remaining: ConditionalRung[],
  tpNew: ResolvedRung[],
  slNew: ResolvedRung[],
  positionLots: bigint,
): void {
  const tpTotal =
    remaining.filter((r) => r.leg === "tp").reduce<bigint>((s, r) => s + r.maxSizeLots, 0n) +
    tpNew.reduce<bigint>((s, r) => s + r.sizeLots, 0n);
  if (tpTotal > positionLots) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "Total TP size would exceed your position.",
      meta: { tpTotalLots: tpTotal.toString(), positionLots: positionLots.toString() },
    });
  }
  const slTotal =
    remaining.filter((r) => r.leg === "sl").reduce<bigint>((s, r) => s + r.maxSizeLots, 0n) +
    slNew.reduce<bigint>((s, r) => s + r.sizeLots, 0n);
  if (slTotal > positionLots) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "Total SL size would exceed your position.",
      meta: { slTotalLots: slTotal.toString(), positionLots: positionLots.toString() },
    });
  }
}

// ── Snapshot reads ──────────────────────────────────────────────────────────

async function fetchSnapshot(walletAddress: string): Promise<TraderStateSnapshotResponse> {
  return withRetry(() =>
    getPhoenixClient().api.traders().getTraderStateSnapshot(walletAddress, { traderPdaIndex: 0 }),
  );
}

export function findPositionInSnapshot(
  snap: TraderStateSnapshotResponse,
  symbol: string,
  positionSide: "long" | "short",
): PositionLookup | null {
  const upper = symbol.toUpperCase();
  for (const sub of snap.snapshot.subaccounts ?? []) {
    for (const p of sub.positions ?? []) {
      if (p.symbol.toUpperCase() !== upper) continue;
      const side = sideOfBaseLots(p.basePositionLots);
      if (side !== positionSide) continue;
      const lots = BigInt(p.basePositionLots);
      const positionLots = lots < 0n ? -lots : lots;
      if (positionLots === 0n) continue;
      return { pos: p, positionLots, side };
    }
  }
  return null;
}

function mustFindPositionInSnapshot(
  snap: TraderStateSnapshotResponse,
  symbol: string,
  positionSide: "long" | "short",
): PositionLookup {
  const found = findPositionInSnapshot(snap, symbol, positionSide);
  if (!found) {
    throw new BotError({
      category: "validation",
      code: "NO_POSITION",
      userMessage: `No open ${symbol} ${positionSide} position.`,
      hint: "It may have been closed or flipped.",
    });
  }
  return found;
}

function modeFromKind(kind: string): ExecMode {
  return kind === "limit" ? "limit" : "market";
}

function rungFromTakeProfit(
  trigger: TraderStateConditionalTakeProfitTrigger,
  parsed: ParsedTriggerId,
  market: MarketLike,
): ConditionalRung {
  const t = trigger.trigger;
  return {
    leg: "tp",
    triggerPrice: ticksToPriceUsd(t.triggerPriceTicks, market),
    executionPrice: ticksToPriceUsd(t.executionPriceTicks, market),
    conditionalOrderIndex: parsed.conditionalOrderIndex,
    triggerDirection: parsed.triggerDirection,
    maxSizeLots: BigInt(t.maxSizeLots),
    fillableSizeLots: BigInt(t.fillableSizeLots),
    filledSizeLots: BigInt(t.filledSizeLots),
    mode: modeFromKind(t.kind),
    rawId: trigger.conditionalTakeProfitId,
  };
}

function rungFromStopLoss(
  trigger: TraderStateConditionalStopLossTrigger,
  parsed: ParsedTriggerId,
  market: MarketLike,
): ConditionalRung {
  const t = trigger.trigger;
  return {
    leg: "sl",
    triggerPrice: ticksToPriceUsd(t.triggerPriceTicks, market),
    executionPrice: ticksToPriceUsd(t.executionPriceTicks, market),
    conditionalOrderIndex: parsed.conditionalOrderIndex,
    triggerDirection: parsed.triggerDirection,
    maxSizeLots: BigInt(t.maxSizeLots),
    fillableSizeLots: BigInt(t.fillableSizeLots),
    filledSizeLots: BigInt(t.filledSizeLots),
    mode: modeFromKind(t.kind),
    rawId: trigger.conditionalStopLossId,
  };
}

export async function getPositionConditionals(
  walletAddress: string,
  symbol: string,
  positionSide: "long" | "short",
): Promise<ConditionalRung[]> {
  const [snap, market] = await Promise.all([fetchSnapshot(walletAddress), getMarket(symbol)]);
  const found = findPositionInSnapshot(snap, symbol, positionSide);
  if (!found) return [];

  const marketLike: MarketLike = {
    tickSize: market.tickSize,
    baseLotsDecimals: market.baseLotsDecimals,
    assetId: market.assetId,
  };

  const rungs: ConditionalRung[] = [];
  for (const t of found.pos.conditionalTakeProfitTriggers ?? []) {
    const parsed = parseConditionalId(t.conditionalTakeProfitId, "tp", market.assetId);
    if (!parsed) {
      logger.warn({ id: t.conditionalTakeProfitId, assetId: market.assetId }, "Unparseable TP id");
      continue;
    }
    rungs.push(rungFromTakeProfit(t, parsed, marketLike));
  }
  for (const t of found.pos.conditionalStopLossTriggers ?? []) {
    const parsed = parseConditionalId(t.conditionalStopLossId, "sl", market.assetId);
    if (!parsed) {
      logger.warn({ id: t.conditionalStopLossId, assetId: market.assetId }, "Unparseable SL id");
      continue;
    }
    rungs.push(rungFromStopLoss(t, parsed, marketLike));
  }
  return rungs;
}

// ── PDA init check ──────────────────────────────────────────────────────────

const _initializedPdaCache = new Set<string>();
let _rpcForReads: ReturnType<typeof createSolanaRpc> | null = null;

function getRpc() {
  if (!_rpcForReads) _rpcForReads = createSolanaRpc(config.HELIUS_RPC_URL);
  return _rpcForReads;
}

export async function needsConditionalOrdersInit(walletAddress: string): Promise<boolean> {
  if (_initializedPdaCache.has(walletAddress)) return false;

  const client = getPhoenixClient();
  const traderPda = await client.pda.getTraderAddress({
    authority: walletAddress as Authority,
    traderPdaIndex: 0,
    subaccountIndex: 0,
  });
  const condPda = await client.pda.getConditionalOrdersAddress({ traderAccount: traderPda });

  const { value } = await getRpc()
    .getAccountInfo(condPda as Address, { commitment: "confirmed", encoding: "base64" })
    .send();

  if (value !== null) {
    _initializedPdaCache.add(walletAddress);
    return false;
  }
  return true;
}

export function markPdaInitialized(walletAddress: string): void {
  _initializedPdaCache.add(walletAddress);
}

// ── Cancel helpers ──────────────────────────────────────────────────────────

export interface CancelDescriptor {
  conditionalOrderIndex: number;
  executionDirection: TriggerDirectionStr;
}

export function findCancelDescriptors(
  rungs: ConditionalRung[],
  leg: Leg,
  indices: number[],
): CancelDescriptor[] {
  const out: CancelDescriptor[] = [];
  for (const idx of indices) {
    const r = rungs.find((x) => x.leg === leg && x.conditionalOrderIndex === idx);
    if (r) {
      out.push({
        conditionalOrderIndex: r.conditionalOrderIndex,
        executionDirection: r.triggerDirection,
      });
    }
  }
  return out;
}

export function subtractCancelled(
  rungs: ConditionalRung[],
  cancelTp: number[] | undefined,
  cancelSl: number[] | undefined,
): ConditionalRung[] {
  const tpSet = new Set(cancelTp ?? []);
  const slSet = new Set(cancelSl ?? []);
  return rungs.filter((r) => {
    if (r.leg === "tp") return !tpSet.has(r.conditionalOrderIndex);
    return !slSet.has(r.conditionalOrderIndex);
  });
}

// ── Build & cancel instructions ─────────────────────────────────────────────

const MAX_ACTIVE_RUNGS = 8;

interface BuildContext {
  client: PhoenixClient;
  market: ExchangeMarketConfig;
}

function buildPlaceIxParams(
  ctx: BuildContext,
  walletAddress: string,
  positionSide: "long" | "short",
  rung: ResolvedRung,
) {
  const closeSide = positionSide === "long" ? Side.Ask : Side.Bid;
  const triggerTicks = priceUsdToTicksBig(rung.triggerPrice, ctx.market);
  const executionTicks =
    rung.mode === "limit" ? triggerTicks : computeMarketExecutionTicks(triggerTicks, closeSide);

  const isGreater =
    (rung.leg === "tp" && positionSide === "long") ||
    (rung.leg === "sl" && positionSide === "short");

  const orderKind = rung.mode === "limit" ? StopLossOrderKind.Limit : StopLossOrderKind.IOC;
  const triggerDirection = isGreater ? Direction.GreaterThan : Direction.LessThan;

  const trigger = {
    triggerDirection,
    tradeSide: closeSide,
    orderKind,
    triggerPrice: ticks(triggerTicks),
    executionPrice: ticks(executionTicks),
  };

  return {
    authority: walletAddress as Authority,
    symbol: riseSymbol(ctx.market.symbol),
    greaterTriggerOrder: isGreater ? trigger : null,
    lessTriggerOrder: isGreater ? null : trigger,
    sizeBaseLots: baseLots(rung.sizeLots) as BaseLots,
    sizePercent: null,
  };
}

// Compatible with addSignersToInstruction's first param shape
type AnyIx = InstructionsWithAccountsAndData;

export async function buildSetPositionTpSlIxs(params: SetPositionTpSlParams): Promise<{
  ixs: AnyIx[];
  pdaInitNeeded: boolean;
}> {
  const client = getPhoenixClient();
  await client.exchange.ready();

  const [snap, market, marketSnap, traderState] = await Promise.all([
    fetchSnapshot(params.walletAddress),
    getMarket(params.symbol),
    getMarketSnapshot(params.symbol),
    getTraderState(params.walletAddress),
  ]);
  const found = mustFindPositionInSnapshot(snap, params.symbol, params.positionSide);

  const marketLike: MarketLike = {
    tickSize: market.tickSize,
    baseLotsDecimals: market.baseLotsDecimals,
    assetId: market.assetId,
  };

  const currentRungs = await getPositionConditionals(
    params.walletAddress,
    params.symbol,
    params.positionSide,
  );

  const cancelTpDesc = findCancelDescriptors(currentRungs, "tp", params.cancelTpIndices ?? []);
  const cancelSlDesc = findCancelDescriptors(currentRungs, "sl", params.cancelSlIndices ?? []);

  const remainingAfterCancels = subtractCancelled(
    currentRungs,
    params.cancelTpIndices,
    params.cancelSlIndices,
  );

  const traderPos = traderState.positions.find(
    (p) => p.symbol === params.symbol && p.side === params.positionSide,
  );
  if (!traderPos) {
    throw new BotError({
      category: "api",
      code: "NO_POSITION",
      userMessage: "Position data not yet synced. Please try again in a moment.",
      retryable: true,
    });
  }
  const posForValidation: PositionForValidation = {
    markPrice: marketSnap.markPrice.toString(),
    liquidationPrice: traderPos.liquidationPrice,
  };

  const tpResolved = resolveRungs(
    params.tp ?? [],
    found.positionLots,
    marketLike,
    params.positionSide,
    posForValidation,
  );
  const slResolved = resolveRungs(
    params.sl ?? [],
    found.positionLots,
    marketLike,
    params.positionSide,
    posForValidation,
  );

  validateSizes(remainingAfterCancels, tpResolved, slResolved, found.positionLots);

  const finalCount = remainingAfterCancels.length + tpResolved.length + slResolved.length;
  if (finalCount > MAX_ACTIVE_RUNGS) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: `Phoenix supports at most ${MAX_ACTIVE_RUNGS} active TP/SL levels per market.`,
      hint: "Remove or merge some existing levels first.",
    });
  }

  const ixs: AnyIx[] = [];
  let pdaInitNeeded = false;

  if (await needsConditionalOrdersInit(params.walletAddress)) {
    pdaInitNeeded = true;
    const initIx = await client.ixs.buildCreateConditionalOrdersAccount({
      authority: params.walletAddress as Authority,
      capacity: MAX_ACTIVE_RUNGS,
    });
    ixs.push(initIx);
  }

  for (const desc of [...cancelTpDesc, ...cancelSlDesc]) {
    const built = await client.api.orders().cancelConditionalOrder({
      authority: params.walletAddress,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
      symbol: params.symbol,
      conditionalOrderIndex: desc.conditionalOrderIndex,
      executionDirection: desc.executionDirection,
    });
    for (const ix of built) ixs.push(ix);
  }

  const buildCtx: BuildContext = { client, market };

  for (const r of [...tpResolved, ...slResolved]) {
    const placeParams = buildPlaceIxParams(buildCtx, params.walletAddress, params.positionSide, r);
    const ix = await client.ixs.buildPlacePositionConditionalOrder(placeParams);
    ixs.push(ix);
  }

  if (ixs.length === 0) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "Nothing to change.",
    });
  }

  return { ixs, pdaInitNeeded };
}

export async function buildCancelIxs(
  walletAddress: string,
  symbol: string,
  positionSide: "long" | "short",
  filter: "tp" | "sl" | "both" | { index: number; leg: Leg },
): Promise<AnyIx[]> {
  const client = getPhoenixClient();
  const rungs = await getPositionConditionals(walletAddress, symbol, positionSide);

  let targets: ConditionalRung[];
  if (typeof filter === "object") {
    const r = rungs.find((x) => x.leg === filter.leg && x.conditionalOrderIndex === filter.index);
    if (!r) {
      throw new BotError({
        category: "validation",
        code: "INVALID_INPUT",
        userMessage: "That level isn't active anymore.",
      });
    }
    targets = [r];
  } else if (filter === "both") {
    targets = rungs;
  } else {
    targets = rungs.filter((r) => r.leg === filter);
  }

  if (targets.length === 0) {
    throw new BotError({
      category: "validation",
      code: "INVALID_INPUT",
      userMessage: "No active levels to cancel.",
    });
  }

  const ixs: AnyIx[] = [];
  for (const r of targets) {
    const built = await client.api.orders().cancelConditionalOrder({
      authority: walletAddress,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
      symbol,
      conditionalOrderIndex: r.conditionalOrderIndex,
      executionDirection: r.triggerDirection,
    });
    for (const ix of built) ixs.push(ix);
  }
  return ixs;
}
