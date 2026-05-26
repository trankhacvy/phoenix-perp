# TP/SL Rewrite — Implementation Plan

**Status:** Draft for review
**Scope:** Replace broken TP/SL feature end-to-end. Position-bracket conditional orders, ladders, full edit/cancel, atomic single-tx writes.
**Anti-scope:** Limit-order-attached brackets (`buildPlaceAttachedConditionalOrder`) — handled in a follow-up, not in this rewrite.

---

## 1. Why the current code is broken

Three live bugs in `src/services/phoenix/trade.ts:377` (`setTpSl`):

1. **Wrong instruction.** Calls `client.ixs.buildPlaceStopLoss`, which is the *attach-to-resting-limit-order* primitive. It is not the position-bracket primitive. With no parent limit order, the on-chain program either errors or no-ops.
2. **No conditional-orders PDA init.** Phoenix stores TP/SL in a per-trader PDA derived from the trader account (`getConditionalOrdersAddress`). The PDA must be created once (`buildCreateConditionalOrdersAccount`, capacity 8) before any conditional order can be placed. We never create it, so the first-ever TP/SL submit silently fails.
3. **Per-level sizing ignored.** `level.fraction` is read but discarded (TODO at trade.ts:402–404). Every rung becomes a 100% close. No ladder.

Plus design issues:

4. Each rung is sent as a **separate transaction** in a `for ... await dispatchInstruction` loop — extra Jito tips, extra confirmation waits, partial-failure surface.
5. `getTraderState` only exposes `pos.takeProfitPrice` / `pos.stopLossPrice` as single scalars; the ladder is invisible to the bot.
6. `cancelStopLoss` cancels by `executionDirection` only — fine for single-rung, wrong for ladders (cancels all rungs in that direction at once when user wanted to remove one).
7. `/settp` and `/settl` exist as standalone slash commands; users expect TP/SL to live on the position.

---

## 2. Phoenix mechanics we will rely on

From `docs/take-profit-stop-loss.md` and the `@ellipsis-labs/rise@0.4.9` SDK types:

### 2.1 Direction mapping

| Position side | TP fires (price …) | SL fires (price …) |
|---|---|---|
| LONG  | ≥ TP → `greaterTriggerOrder` (`Direction.GreaterThan`) | ≤ SL → `lessTriggerOrder` (`Direction.LessThan`) |
| SHORT | ≤ TP → `lessTriggerOrder` (`Direction.LessThan`)     | ≥ SL → `greaterTriggerOrder` (`Direction.GreaterThan`) |

Close side = opposite of position side: LONG → `Side.Ask`, SHORT → `Side.Bid`.

### 2.2 Execution modes

| Mode  | `orderKind` | `executionPrice` |
|---|---|---|
| Limit  | `StopLossOrderKind.Limit` | = `triggerPrice` (rests on book until filled) |
| Market | `StopLossOrderKind.IOC`   | trigger ± 10% buffer (IOC, may partial-fill) |

10% buffer direction matches *trade* side: LONG close (Ask) wants to sell down, so `executionPrice = trigger * 0.90`; SHORT close (Bid) wants to buy up, so `executionPrice = trigger * 1.10`.

### 2.3 SDK call signatures

```ts
// place
client.ixs.buildPlacePositionConditionalOrder({
  authority: Authority,
  symbol: Symbol,
  greaterTriggerOrder: TriggerOrderParams | null,
  lessTriggerOrder:    TriggerOrderParams | null,
  sizeBaseLots:        bigint | null,   // explicit lots (preferred — non-zero max_size in UI)
  sizePercent:         number | null,   // alternative, 1..100
})

// PDA init (idempotent — only needed first time)
client.ixs.buildCreateConditionalOrdersAccount({
  authority: Authority,
  capacity: 8,
})

// cancel one rung by index (server-built ix bundle)
client.api.orders().cancelConditionalOrder({
  authority: string,
  traderPdaIndex: number,        // 0 in our code
  traderSubaccountIndex: number, // 0 for cross
  symbol: string,
  conditionalOrderIndex: number, // from parsed trigger ID
  executionDirection: "greater_than" | "less_than",
})

// list ladder for a position
client.api.traders().getTraderStateSnapshot(authority).snapshot.subaccounts[i].positions[j]
  .conditionalTakeProfitTriggers[]  // [{ conditionalTakeProfitId, trigger:{triggerPriceTicks,…} }]
  .conditionalStopLossTriggers[]

// PDA address (for "is initialized" check)
client.addresses.getConditionalOrdersAddress({ traderAccount })
```

### 2.4 Trigger ID format

Per vulcan (`vulcan-lib/src/commands/trade.rs:2357 parse_conditional_order_id`):

```
ctp-{assetId}-{conditionalOrderIndex}-{gt|lt}    // take profit
csl-{assetId}-{conditionalOrderIndex}-{gt|lt}    // stop loss
```

This is the canonical way to recover the index needed for cancellation. We parse with the same logic.

### 2.5 Capacity & invalidation

- One PDA per `(authority, pdaIndex, subaccountIndex)` with capacity 8 active conditional orders combined (TP + SL).
- **Position flip cancels every conditional order on that market** (docs §Position flips). Our existing `tpsl_flip` alert in `src/workers/ws.ts:240` already detects this; new manager handles the "no rungs" state correctly without code change.
- Reduce-only and self-trade-prevention applies on execution.

---

## 3. Files touched

### Delete
- `src/bot/commands/settp.ts`
- `src/bot/commands/setsl.ts`
- `tests/unit/services/preflight.test.ts` — keep (unrelated)

### Create
- `src/services/phoenix/conditional.ts` — service: list/place/cancel position conditionals
- `src/bot/commands/tpsl.ts` — bot UI: manager screen + add-rung wizard + edit/remove flows
- `tests/unit/services/conditional.test.ts` — unit tests for trigger parsing, direction map, size resolution

### Modify
- `src/services/phoenix/trade.ts` — remove `setTpSl`, `cancelStopLoss`, related types; keep `placeMarketOrder`/`closePosition`/etc untouched. Export new `setPositionTpSl`, `cancelPositionConditional`, `cancelAllPositionConditionals` proxying to the new service module (or move entirely — see §4.1).
- `src/services/phoenix/position.ts` — extend `getTraderState` (or add `getPositionConditionals`) to surface ladder rungs from the snapshot endpoint.
- `src/types/index.ts` — extend `PhoenixPosition` with `tpRungs: ConditionalRung[]`, `slRungs: ConditionalRung[]` (replacing the scalar `takeProfit`/`stopLoss`).
- `src/bot/commands/index.ts` — register `registerTpSl(bot)`, drop unused setSl/setTp registers (already commented out).
- `src/bot/commands/positions.ts` — replace the two row buttons (`editsl:`/`edittp:`) with state-aware labels routing to the new manager; `buildDetailText` shows ladder summary.
- `src/bot/keyboards/position.ts` — same callback names changed to `tpsl:open:tp:…` / `tpsl:open:sl:…`.
- `src/bot/index.ts` — text-dispatcher: rename pending keys, route new wizard steps; drop the old `editsl`/`edittp` branches.
- `src/bot/commands/long.ts` — auto-TP/SL on open: route through the new service (one tx, lazy PDA init), drop the old `setTpSl` import.

---

## 4. New service module: `src/services/phoenix/conditional.ts`

### 4.1 Types

```ts
import {
  type Authority,
  Direction,
  type Position as SdkPosition,
  Side,
  StopLossOrderKind,
  type TraderStateConditionalTakeProfitTrigger,
  type TraderStateConditionalStopLossTrigger,
  baseLots,
  priceUsdToTicks,
  symbol as riseSymbol,
} from "@ellipsis-labs/rise";

export type Leg = "tp" | "sl";
export type ExecMode = "limit" | "market";

/** A live conditional rung on a position, parsed from trader-state. */
export interface ConditionalRung {
  leg: Leg;
  /** Trigger price in USD (decimal). */
  triggerPrice: number;
  /** Execution price in USD. Limit: = triggerPrice. Market: trigger ± 10%. */
  executionPrice: number;
  /** Index inside the conditional-orders account — required to cancel. */
  conditionalOrderIndex: number;
  /** "greater_than" or "less_than" — required to cancel. */
  triggerDirection: "greater_than" | "less_than";
  /** Reduce-only size in base lots. */
  maxSizeLots: bigint;
  fillableSizeLots: bigint;
  filledSizeLots: bigint;
  mode: ExecMode;
  /** Raw trigger id string for debugging / dedup. */
  id: string;
}

/** Wizard input — caller has *not yet* resolved size to lots. */
export interface RungInput {
  leg: Leg;
  triggerPrice: number;
  mode: ExecMode;
  size:
    | { kind: "full" }            // 100% of position
    | { kind: "lots"; lots: bigint }
    | { kind: "tokens"; tokens: number }
    | { kind: "percent"; pct: number }; // 1..100 of remaining unallocated
}
```

### 4.2 Listing live rungs

We pull the position object **from `getTraderStateSnapshot`**, not the lean `getTraderState`. The snapshot includes the four trigger arrays per position; the lean view only has scalar `takeProfitPrice`/`stopLossPrice`.

```ts
export async function getPositionConditionals(
  walletAddress: string,
  symbol: string,
  positionSide: "long" | "short",
): Promise<ConditionalRung[]> {
  const snap = await getPhoenixClient()
    .api.traders()
    .getTraderStateSnapshot(walletAddress, { traderPdaIndex: 0 });

  const sub = snap.snapshot.subaccounts.find((s) => s.subaccountIndex === 0);
  if (!sub) return [];

  const pos = sub.positions.find(
    (p) =>
      p.symbol.toUpperCase() === symbol.toUpperCase() &&
      sideOfBaseLots(p.basePositionLots) === positionSide,
  );
  if (!pos) return [];

  const market = await getMarket(symbol);
  const lotToBase = 10 ** -market.baseLotsDecimals;
  const tickToUsd = market.tickSize * lotToBase; // verify against SDK helper

  const rungs: ConditionalRung[] = [];
  for (const t of pos.conditionalTakeProfitTriggers ?? []) {
    const parsed = parseConditionalId(t.conditionalTakeProfitId, "tp", market.assetId);
    if (!parsed) continue;
    rungs.push(rungFromTrigger("tp", t.trigger, parsed, tickToUsd));
  }
  for (const t of pos.conditionalStopLossTriggers ?? []) {
    const parsed = parseConditionalId(t.conditionalStopLossId, "sl", market.assetId);
    if (!parsed) continue;
    rungs.push(rungFromTrigger("sl", t.trigger, parsed, tickToUsd));
  }
  return rungs;
}

function sideOfBaseLots(raw: string): "long" | "short" {
  return raw.startsWith("-") ? "short" : "long";
}

interface ParsedTriggerId {
  conditionalOrderIndex: number;
  triggerDirection: "greater_than" | "less_than";
}

function parseConditionalId(
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
  if (assetId !== expectAssetId || !Number.isInteger(idx) || idx < 0) return null;
  if (dirStr !== "gt" && dirStr !== "lt") return null;
  return {
    conditionalOrderIndex: idx,
    triggerDirection: dirStr === "gt" ? "greater_than" : "less_than",
  };
}

function rungFromTrigger(
  leg: Leg,
  t: { triggerPriceTicks: string; executionPriceTicks: string; kind: "ioc" | "limit"; maxSizeLots: string; fillableSizeLots: string; filledSizeLots: string },
  parsed: ParsedTriggerId,
  tickToUsd: number,
): ConditionalRung {
  const trigPx = Number(t.triggerPriceTicks) * tickToUsd;
  const execPx = Number(t.executionPriceTicks) * tickToUsd;
  return {
    leg,
    triggerPrice: trigPx,
    executionPrice: execPx,
    conditionalOrderIndex: parsed.conditionalOrderIndex,
    triggerDirection: parsed.triggerDirection,
    maxSizeLots: BigInt(t.maxSizeLots),
    fillableSizeLots: BigInt(t.fillableSizeLots),
    filledSizeLots: BigInt(t.filledSizeLots),
    mode: t.kind === "limit" ? "limit" : "market",
    id: leg === "tp" ? `ctp-…` : `csl-…`, // copy the raw id for telemetry
  };
}
```

> **Verify before merging:** the exact path to `tickToUsd` — Rise SDK may already expose `ticksToPriceUsd`. Use that helper rather than recomputing from `tickSize × lotToBase` if available.

### 4.3 Placing — atomic, multi-rung, PDA-aware

```ts
export interface SetPositionTpSlParams {
  symbol: string;
  walletAddress: string;
  positionSide: "long" | "short";
  /** New TP rungs to place. Empty = no TP changes. */
  tp?: RungInput[];
  /** New SL rungs to place. Empty = no SL changes. */
  sl?: RungInput[];
  /** Rung indices on the current ladder to cancel before placing. */
  cancelTpIndices?: number[];
  cancelSlIndices?: number[];
}

export async function setPositionTpSl(
  params: SetPositionTpSlParams,
  fee?: FeeConfig,
): Promise<string> {
  const client = getTradingClient();
  await client.exchange.ready();

  // 1. fetch authoritative position size (in base lots, BigInt)
  const snap = await getPhoenixClient()
    .api.traders()
    .getTraderStateSnapshot(params.walletAddress, { traderPdaIndex: 0 });
  const { pos, positionLots } = mustFindPositionLots(snap, params.symbol, params.positionSide);

  const market = await getMarket(params.symbol);

  // 2. resolve every input rung to explicit base lots
  const tpResolved = resolveRungs(params.tp ?? [], positionLots, market, "tp", params.positionSide, pos);
  const slResolved = resolveRungs(params.sl ?? [], positionLots, market, "sl", params.positionSide, pos);

  // 3. sum guard — total reduce-only commitment ≤ position size
  const currentRungs = await getPositionConditionals(params.walletAddress, params.symbol, params.positionSide);
  const remainingAfterCancels = subtractCancelled(currentRungs, params.cancelTpIndices, params.cancelSlIndices);
  validateSizes(remainingAfterCancels, tpResolved, slResolved, positionLots);

  // 4. capacity guard — Phoenix PDA holds 8 active rungs combined
  const finalCount =
    remainingAfterCancels.length + tpResolved.length + slResolved.length;
  if (finalCount > 8) {
    throw new BotError({
      category: "validation",
      code: "TPSL_CAPACITY",
      userMessage: "Phoenix supports at most 8 active TP/SL levels per market.",
      hint: "Remove or merge some existing levels first.",
    });
  }

  const ixs: AnyInstruction[] = [];

  // 5. lazy PDA init — single check, cached per process
  if (await needsConditionalOrdersInit(params.walletAddress)) {
    ixs.push(
      await client.ixs.buildCreateConditionalOrdersAccount({
        authority: params.walletAddress as Authority,
        capacity: 8,
      }),
    );
  }

  // 6. cancel-by-index ixs (uses HTTP API which returns ready ixs)
  for (const idx of params.cancelTpIndices ?? []) {
    const rung = currentRungs.find((r) => r.leg === "tp" && r.conditionalOrderIndex === idx);
    if (!rung) continue;
    const built = await client.api.orders().cancelConditionalOrder({
      authority: params.walletAddress,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
      symbol: params.symbol,
      conditionalOrderIndex: idx,
      executionDirection: rung.triggerDirection,
    });
    ixs.push(...built); // SDK returns InstructionsWithAccountsAndData[]
  }
  for (const idx of params.cancelSlIndices ?? []) {
    /* symmetric */
  }

  // 7. place ixs
  const closeSide = params.positionSide === "long" ? Side.Ask : Side.Bid;
  const marketSym = riseSymbol(params.symbol.toUpperCase());

  for (const r of tpResolved) {
    ixs.push(await buildPlaceIx(client, params, marketSym, market, closeSide, r));
  }
  for (const r of slResolved) {
    ixs.push(await buildPlaceIx(client, params, marketSym, market, closeSide, r));
  }

  if (ixs.length === 0) {
    throw new BotError({
      category: "validation",
      code: "NO_OP",
      userMessage: "Nothing to change.",
    });
  }

  // 8. single tx — reuse existing dispatchInstructions infra from trade.ts
  return dispatchInstructions(ixs, params.walletAddress, fee);
}

async function buildPlaceIx(
  client: PhoenixRiseClient,
  params: SetPositionTpSlParams,
  marketSym: ReturnType<typeof riseSymbol>,
  market: { tickSize: number; baseLotsDecimals: number },
  closeSide: Side,
  r: ResolvedRung,
) {
  const triggerTicks = priceUsdToTicks(r.triggerPrice, {
    tickSizeInQuoteLotsPerBaseLot: market.tickSize,
    baseLotsDecimals: market.baseLotsDecimals,
  });
  const executionTicks = r.mode === "limit"
    ? triggerTicks
    : computeMarketExecutionTicks(triggerTicks, closeSide); // ±10% buffer

  const isGreater =
    (r.leg === "tp" && params.positionSide === "long") ||
    (r.leg === "sl" && params.positionSide === "short");

  const triggerDir = isGreater ? Direction.GreaterThan : Direction.LessThan;

  const trigger = {
    triggerDirection: triggerDir,
    tradeSide: closeSide,
    orderKind: r.mode === "limit" ? StopLossOrderKind.Limit : StopLossOrderKind.IOC,
    triggerPrice: BigInt(triggerTicks),
    executionPrice: BigInt(executionTicks),
  };

  return client.ixs.buildPlacePositionConditionalOrder({
    authority: params.walletAddress as Authority,
    symbol: marketSym,
    greaterTriggerOrder: isGreater ? trigger : null,
    lessTriggerOrder:    isGreater ? null : trigger,
    sizeBaseLots: baseLots(r.sizeLots),
    sizePercent: null,
  });
}

function computeMarketExecutionTicks(triggerTicks: number, closeSide: Side): number {
  // LONG close = Ask, willing to sell down: 0.90× trigger
  // SHORT close = Bid, willing to buy up:   1.10× trigger
  const mult = closeSide === Side.Ask ? 0.9 : 1.1;
  return Math.floor(triggerTicks * mult);
}
```

### 4.4 PDA init cache

```ts
const _initializedPdaCache = new Set<string>();

async function needsConditionalOrdersInit(walletAddress: string): Promise<boolean> {
  if (_initializedPdaCache.has(walletAddress)) return false;

  const client = getTradingClient();
  const traderPda = await client.addresses.getTraderAddress({
    authority: walletAddress as Authority,
    traderPdaIndex: 0,
    traderSubaccountIndex: 0,
  });
  const condPda = await client.addresses.getConditionalOrdersAddress({
    traderAccount: traderPda,
  });

  const rpc = createSolanaRpc(config.HELIUS_RPC_URL); // reuse cached one from trade.ts
  const { value } = await rpc.getAccountInfo(condPda as Address, { commitment: "confirmed" }).send();

  if (value && value.data && value.data[0].length > 0) {
    _initializedPdaCache.add(walletAddress);
    return false;
  }
  return true;
}
```

> Cache lives in-process. If the bot restarts we re-check once per wallet — cheap. We **never** clear the cache: an initialized PDA cannot be de-initialized in normal flow.

### 4.5 Size resolution + sum validation

```ts
interface ResolvedRung {
  leg: Leg;
  triggerPrice: number;
  mode: ExecMode;
  sizeLots: bigint;
}

function resolveRungs(
  inputs: RungInput[],
  positionLots: bigint,
  market: { baseLotsDecimals: number },
  leg: Leg,
  side: "long" | "short",
  pos: TraderStatePositionSnapshot,
): ResolvedRung[] {
  if (inputs.length === 0) return [];

  // Vulcan rule: "full" is only valid as the single rung on a leg.
  const fullCount = inputs.filter((i) => i.size.kind === "full").length;
  if (inputs.length > 1 && fullCount > 0) {
    throw new BotError({
      category: "validation",
      code: "TPSL_FULL_WITH_MULTI",
      userMessage: "When you have multiple levels on a leg, every level needs an explicit size.",
    });
  }

  return inputs.map((inp) => {
    validateTriggerPrice(inp.triggerPrice, leg, side, pos);   // §6
    const sizeLots = resolveSize(inp.size, positionLots, market);
    if (sizeLots <= 0n) {
      throw new BotError({
        category: "validation",
        code: "TPSL_SIZE_TOO_SMALL",
        userMessage: `Resolved size is 0 base lots for price ${inp.triggerPrice}.`,
      });
    }
    return { leg, triggerPrice: inp.triggerPrice, mode: inp.mode, sizeLots };
  });
}

function resolveSize(
  size: RungInput["size"],
  positionLots: bigint,
  market: { baseLotsDecimals: number },
): bigint {
  switch (size.kind) {
    case "full":    return positionLots;
    case "lots":    return size.lots;
    case "tokens":  return BigInt(Math.floor(size.tokens * 10 ** market.baseLotsDecimals));
    case "percent": return (positionLots * BigInt(Math.floor(size.pct * 100))) / 10_000n;
  }
}

function validateSizes(
  remaining: ConditionalRung[],
  tpNew: ResolvedRung[],
  slNew: ResolvedRung[],
  positionLots: bigint,
) {
  const tpTotal =
    remaining.filter((r) => r.leg === "tp").reduce((s, r) => s + r.maxSizeLots, 0n) +
    tpNew.reduce((s, r) => s + r.sizeLots, 0n);
  if (tpTotal > positionLots) {
    throw new BotError({
      category: "validation",
      code: "TP_SIZE_EXCEEDS_POSITION",
      userMessage: `Total TP size would exceed your position.`,
      meta: { tpTotalLots: String(tpTotal), positionLots: String(positionLots) },
    });
  }
  // symmetric for SL
}
```

### 4.6 Cancels

```ts
export async function cancelPositionConditional(
  walletAddress: string,
  symbol: string,
  positionSide: "long" | "short",
  leg: Leg,
  conditionalOrderIndex: number,
  fee?: FeeConfig,
): Promise<string> {
  const rungs = await getPositionConditionals(walletAddress, symbol, positionSide);
  const rung = rungs.find((r) => r.leg === leg && r.conditionalOrderIndex === conditionalOrderIndex);
  if (!rung) {
    throw new BotError({
      category: "validation",
      code: "TPSL_NOT_FOUND",
      userMessage: "That level isn't active anymore.",
    });
  }
  const ixs = await getPhoenixClient().api.orders().cancelConditionalOrder({
    authority: walletAddress,
    traderPdaIndex: 0,
    traderSubaccountIndex: 0,
    symbol,
    conditionalOrderIndex,
    executionDirection: rung.triggerDirection,
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
  const rungs = await getPositionConditionals(walletAddress, symbol, positionSide);
  const target = rungs.filter((r) => filter === "both" || r.leg === filter);
  if (target.length === 0) {
    throw new BotError({
      category: "validation",
      code: "TPSL_NOTHING_TO_CANCEL",
      userMessage: "No active levels to cancel.",
    });
  }
  const ixs: AnyInstruction[] = [];
  for (const r of target) {
    const built = await getPhoenixClient().api.orders().cancelConditionalOrder({
      authority: walletAddress,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
      symbol,
      conditionalOrderIndex: r.conditionalOrderIndex,
      executionDirection: r.triggerDirection,
    });
    ixs.push(...(built as AnyInstruction[]));
  }
  return dispatchInstructions(ixs, walletAddress, fee);
}
```

---

## 5. Bot UI: `src/bot/commands/tpsl.ts`

### 5.1 Callback namespace

All callbacks use the `tpsl:` prefix. Concise so they stay under Telegram's 64-byte limit even with long symbols (`WTIOIL`, etc).

```
tpsl:open:{leg}:{sym}:{side}                  # open manager
tpsl:add:{leg}:{sym}:{side}                   # start add wizard (price step)
tpsl:px:{leg}:{sym}:{side}:{pct10}            # preset % → goes to size step
tpsl:pxc:{leg}:{sym}:{side}                   # custom price prompt → pending key
tpsl:sz:{leg}:{sym}:{side}:{pxStr}:{pct}      # preset size %
tpsl:szc:{leg}:{sym}:{side}:{pxStr}           # custom tokens prompt → pending key
tpsl:szf:{leg}:{sym}:{side}:{pxStr}           # "full" / "rest" shortcut
tpsl:md:{leg}:{sym}:{side}:{pxStr}:{lots}:{md}  # mode toggle, advances to confirm
tpsl:go:{leg}:{sym}:{side}:{pxStr}:{lots}:{md}  # confirm — fires tx
tpsl:row:{leg}:{sym}:{side}:{idx}             # row action sheet
tpsl:rm:{leg}:{sym}:{side}:{idx}              # remove one rung (confirm)
tpsl:rmgo:{leg}:{sym}:{side}:{idx}            # remove exec
tpsl:clr:{leg}:{sym}:{side}                   # clear-all confirm
tpsl:clrgo:{leg}:{sym}:{side}                 # clear-all exec
tpsl:rep:{leg}:{sym}:{side}                   # replace-all → wizard with cancel flag
tpsl:repgo:{leg}:{sym}:{side}:{pxStr}:{lots}:{md}
```

`{pct10}` = integer percent ×10 to support 5.5 etc (`055` = 5.5%). `{pxStr}` uses the existing `priceForCallback` helper (`toFixed(8).replace(/\.?0+$/, "")`).

`{lots}` is bigint stringified.

### 5.2 Pending keys (Redis `pending:<tgId>`)

```
tpsl_px:{leg}:{sym}:{side}                  # awaiting custom trigger price
tpsl_sz:{leg}:{sym}:{side}:{pxStr}          # awaiting custom token amount
```

Text dispatcher in `src/bot/index.ts:61 on("message:text")` learns two new branches following the existing pattern.

### 5.3 Manager screen

```ts
export async function sendTpSlManager(
  ctx: BotContext,
  leg: Leg,
  symbol: string,
  positionSide: "long" | "short",
  edit = false,
): Promise<void> {
  if (!ctx.user) return;

  const [state, rungsAll, market] = await Promise.all([
    getTraderState(ctx.user.walletAddress),
    getPositionConditionals(ctx.user.walletAddress, symbol, positionSide),
    getMarket(symbol).catch(() => null),
  ]);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === positionSide);
  if (!pos) {
    const msg = `No open ${symbol} ${positionSide} position. It may have been closed.`;
    return edit && ctx.callbackQuery ? ctx.editMessageText(msg) : ctx.reply(msg);
  }

  const rungs = rungsAll.filter((r) => r.leg === leg);
  const positionLots = BigInt(/* from snapshot */);
  const allocatedLots = rungs.reduce((s, r) => s + r.maxSizeLots, 0n);
  const remainingLots = positionLots > allocatedLots ? positionLots - allocatedLots : 0n;

  // Build header (entry, mark, size, uPnL) + ladder list + actions
  // (full template in §5.4)
}
```

### 5.4 Screen templates

**Empty state (no rungs)** — TP:

```
🎯 Take Profit — SOL LONG
━━━━━━━━━━━━━━━━━━━━━━━━━
Entry      $86.50
Mark       $87.20  (+0.81%)
Size       11.45 SOL  ($998.94)
uPnL       +$8.02 🟢

No take profit set.

Quick presets:
[+5%  $91.56]   [+10%  $95.92]
[+20% $104.64]  [+30%  $113.36]
[+50% $130.80]
[✏️ Custom price]
[← Back]
```

Tapping a preset → straight to **confirm** (size = full, mode = limit for TP, market for SL). User can override mode from confirm screen.

**Populated state (≥1 rung)** — TP ladder:

```
🎯 Take Profit — SOL LONG
━━━━━━━━━━━━━━━━━━━━━━━━━
Entry $86.50 · Mark $87.20 · Size 11.45 SOL

Active levels (2):
①  $95.40   +10.2%  ·  5.72 SOL (50%)  ·  limit  ·  est +$45.40
②  $103.80  +20.0%  ·  5.72 SOL (50%)  ·  limit  ·  est +$83.60
Covered: 100% of position

Tap a level to edit/remove.

[① Edit]  [② Edit]
[+ Add level]  ← disabled if Covered = 100%
[🗑 Clear all]
[← Back]
```

Tap on `① Edit` → row action sheet:

```
TP ① · $95.40 · 50% · limit
[✏️ Change price]  [✏️ Change size]
[🔁 Switch to market]  [🗑 Remove]
[← Back to manager]
```

### 5.5 Add-rung wizard — 3 steps + confirm

**Step 1 — Price** (only shown for `+ Add level`; presets-on-empty path skips to confirm):

```
🎯 Add TP level — SOL LONG
Entry $86.50 · Mark $87.20

Pick trigger price:
[+5%]  [+10%]  [+20%]  [+30%]  [+50%]
[✏️ Enter price manually]
[← Back]
```

Custom price → set pending key `tpsl_px:tp:SOL:long` → user types → `on("message:text")` validates with `validateTriggerPrice` (§6) → advances to step 2.

**Step 2 — Size** (skipped on first rung; uses "full" implicitly):

```
Trigger $95.40 (+10.2%)
Remaining unallocated: 5.72 SOL (50%)

How much to close here?
[25%   1.43 SOL]   [50%   2.86 SOL]
[75%   4.29 SOL]   [100%  5.72 SOL]
[✏️ Custom tokens]
[← Change price]
```

Custom → pending `tpsl_sz:tp:SOL:long:95.40`. Validation: tokens > 0, `lots ≥ 1`, `lots ≤ remainingLots`.

**Step 3 — Mode (compact toggle on confirm screen — saves a step):**

```
🎯 Confirm TP level — SOL LONG
━━━━━━━━━━━━━━━━━━━━━━━━━
Trigger     $95.40  (+10.2% from entry)
Size        5.72 SOL  (50% of position)
Execution   [★ Limit]   [Market]
Est. PnL    +$45.40  (at trigger, excl. fees)

After this: 50% of position unprotected.

[✅ Submit]   [← Back]   [✕ Cancel]
```

`[★ Limit] [Market]` row uses two callbacks: tapping the non-active mode re-renders the same screen with star moved, encoding mode in the next callback.

**Submit** → `tpsl:go:…` → calls `setPositionTpSl({ tp: [{ triggerPrice, mode, size: { kind: "lots", lots } }] })`.

### 5.6 Edit existing rung

Single rung edit = **cancel-by-index + place-new in one tx**, via `setPositionTpSl({ cancelTpIndices: [idx], tp: [newRung] })`.

The wizard reuses the same screens, prefilled. The user changes only what they want.

### 5.7 Clear-all / Replace-all

- **Clear all** (`tpsl:clr` → confirm → `tpsl:clrgo`) → `cancelAllPositionConditionals(wallet, symbol, side, leg)`.
- **Replace all** = collapses to "Clear all + add single rung" in one tx via `setPositionTpSl({ cancelTpIndices: [allIdxs], tp: [newRung] })`.

### 5.8 Entry from positions

`src/bot/commands/positions.ts:positionKeyboard` becomes:

```ts
export function positionKeyboard(
  symbol: string,
  side: "long" | "short",
  hasTp: boolean,
  hasSl: boolean,
): InlineKeyboard {
  return new InlineKeyboard()
    .text("Close 25%", `close:${symbol}:25:${side}`)
    .text("Close 50%", `close:${symbol}:50:${side}`)
    .text("Close 100%", `close:${symbol}:100:${side}`)
    .row()
    .text("Add Margin", `margin:${symbol}`)
    .text(hasTp ? "🎯 TP ✓" : "🎯 Set TP", `tpsl:open:tp:${symbol}:${side}`)
    .text(hasSl ? "🛑 SL ✓" : "🛑 Set SL", `tpsl:open:sl:${symbol}:${side}`)
    .row()
    .text("🔄 Refresh", `pos:refresh:${symbol}:${side}`)
    .text("◀ Back", "pos:list");
}
```

`buildDetailText` shows ladder summary inline:

```
Take profit   ② levels  +10% / +20%
Stop loss     -3% at $83.95 (limit, 100%)
```

(or `—` if none)

### 5.9 Trade-open + auto-TP/SL

`src/bot/commands/long.ts:executeTrade` block at lines 496–530 is the one place auto-TP/SL fires. Rewrite to a single call:

```ts
if (settings.autoTpPct || settings.autoSlPct) {
  const tp = settings.autoTpPct ? [{
    leg: "tp" as const,
    triggerPrice: side === "long"
      ? entryPrice * (1 + settings.autoTpPct / 100)
      : entryPrice * (1 - settings.autoTpPct / 100),
    mode: "limit" as const,
    size: { kind: "full" as const },
  }] : [];
  const sl = settings.autoSlPct ? [{
    leg: "sl" as const,
    triggerPrice: side === "long"
      ? entryPrice * (1 - settings.autoSlPct / 100)
      : entryPrice * (1 + settings.autoSlPct / 100),
    mode: "market" as const,
    size: { kind: "full" as const },
  }] : [];

  try {
    await setPositionTpSl({ symbol, walletAddress: wallet, positionSide: side, tp, sl }, fee);
    autoTpSlNote = fmt`\n🤖 Auto TP/SL set`;
  } catch (err) {
    logger.warn({ err, symbol, side }, "Auto TP/SL failed (non-fatal)");
    autoTpSlNote = fmt`\n⚠️ Auto TP/SL could not be set — set manually.`;
  }
}
```

The on-open flow runs **after** the market-order tx confirms, so the position exists. PDA init happens inside `setPositionTpSl` if needed — single tx for both TP+SL.

---

## 6. Validation (§ "validate input correctly")

All validators live in `src/services/phoenix/conditional.ts` so they're reusable from preflight, manual entry, preset taps, and edits.

```ts
export function validateTriggerPrice(
  price: number,
  leg: Leg,
  positionSide: "long" | "short",
  pos: { markPrice: string; liquidationPrice: string },
): void {
  if (!Number.isFinite(price) || price <= 0) {
    throw new BotError({ category: "validation", code: "TPSL_BAD_PRICE",
      userMessage: "Enter a positive price." });
  }
  const mark = Number(pos.markPrice);
  const liq = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);

  if (leg === "tp") {
    if (positionSide === "long" && price <= mark) {
      throw new BotError({ category: "validation", code: "TP_BELOW_MARK",
        userMessage: `TP for a long must be above current price ($${mark}).` });
    }
    if (positionSide === "short" && price >= mark) {
      throw new BotError({ category: "validation", code: "TP_ABOVE_MARK",
        userMessage: `TP for a short must be below current price ($${mark}).` });
    }
  } else {
    // SL — must protect, not be already triggered. Also must be on the safe side of liq.
    if (positionSide === "long") {
      if (price >= mark) {
        throw new BotError({ category: "validation", code: "SL_ABOVE_MARK",
          userMessage: `SL for a long must be below current price ($${mark}).` });
      }
      if (liq > 0 && price <= liq) {
        throw new BotError({ category: "validation", code: "SL_AT_OR_BELOW_LIQ",
          userMessage: `SL at $${price} is at/below your liquidation ($${liq}).`,
          hint: `Set an SL above $${liq}.` });
      }
    } else {
      if (price <= mark) {
        throw new BotError({ category: "validation", code: "SL_BELOW_MARK",
          userMessage: `SL for a short must be above current price ($${mark}).` });
      }
      if (liq > 0 && price >= liq) {
        throw new BotError({ category: "validation", code: "SL_AT_OR_ABOVE_LIQ",
          userMessage: `SL at $${price} is at/above your liquidation ($${liq}).` });
      }
    }
  }
}

export function validateMode(mode: string): asserts mode is ExecMode {
  if (mode !== "limit" && mode !== "market") {
    throw new BotError({ category: "validation", code: "TPSL_BAD_MODE",
      userMessage: "Mode must be limit or market." });
  }
}

export function validateSize(
  size: RungInput["size"],
  positionLots: bigint,
  remainingLots: bigint,
  market: { baseLotsDecimals: number },
): bigint {
  const lots = resolveSize(size, positionLots, market);
  if (lots <= 0n) {
    throw new BotError({ category: "validation", code: "TPSL_SIZE_ZERO",
      userMessage: "Size must be more than 0.",
      hint: `Minimum 1 base lot (~${10 ** -market.baseLotsDecimals}).` });
  }
  if (lots > remainingLots) {
    const tokens = Number(remainingLots) * 10 ** -market.baseLotsDecimals;
    throw new BotError({ category: "validation", code: "TPSL_SIZE_OVER",
      userMessage: `That exceeds remaining unallocated size (${tokens}).` });
  }
  return lots;
}
```

Re-validate at **every** boundary:

| Boundary | Validators run |
|---|---|
| Custom price entered (text dispatch) | `validateTriggerPrice` against freshly-fetched mark |
| Preset price tapped | none here — preset is computed from mark, but re-validated in confirm |
| Size entered/tapped | `validateSize` against freshly-fetched position lots |
| Mode tapped | `validateMode` (defensive — callbacks already constrained) |
| Confirm tapped (`tpsl:go`) | full re-validation inside `setPositionTpSl` (price, size, sum, capacity) |
| Edit existing rung | same as new rung; remaining = `positionLots − allocated + edited.maxSizeLots` |

Re-validating at confirm catches the "preset was stale when user finally tapped submit" case (already a pattern in `sendTpFinalConfirm`).

---

## 7. Edge cases — explicit list with handling

| Case | Where caught | Response |
|---|---|---|
| User has no position | `mustFindPositionLots` in service | `BotError NO_POSITION` → manager redirects to `/positions` with friendly msg |
| Position closed while user is in wizard | service re-fetches at confirm | `NO_POSITION` → edit msg to "Position closed. Start over." with `Back to positions` button |
| Position flipped while user is in wizard | service re-fetches at confirm | All prior conditional orders already cancelled by Phoenix; treat as fresh state → suggest user re-enter |
| WS `tpsl_flip` alert fires | existing handler in `src/workers/ws.ts:240` | Buttons in alert route to new `tpsl:open:tp` / `tpsl:open:sl` — no code change needed beyond callback rename |
| PDA never initialized | lazy init inside `setPositionTpSl` | One extra ix in the same tx; transparent to user |
| PDA capacity full (8 rungs) | sum guard in service | `TPSL_CAPACITY` → "Remove some levels first" |
| User sums rungs > 100% of position | `validateSizes` | `TP_SIZE_EXCEEDS_POSITION` / `SL_SIZE_EXCEEDS_POSITION` |
| User chooses "full" + adds another rung | `resolveRungs` (multi+full check) | `TPSL_FULL_WITH_MULTI` → "Specify explicit size per level" |
| Trigger price ≤ liq (long SL) or ≥ liq (short SL) | `validateTriggerPrice` | `SL_AT_OR_BELOW_LIQ` / `SL_AT_OR_ABOVE_LIQ` |
| Trigger price on wrong side of mark | `validateTriggerPrice` | `TP_BELOW_MARK` / `SL_ABOVE_MARK` etc |
| Size resolves to < 1 base lot | `validateSize` | `TPSL_SIZE_ZERO` with min hint |
| Custom tokens > position size | `validateSize` | `TPSL_SIZE_OVER` |
| Price drift between preset tap and submit | re-validate in confirm | message says "price moved" → re-render manager |
| Telegram callback longer than 64 bytes | `priceForCallback` strips zeros; symbol caps at 6 chars in practice | None — measured worst case: `tpsl:go:tp:WTIOIL:long:104.8:11450000:limit` = 47 bytes |
| User double-taps Submit | `claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id)` | Second tap returns silently |
| User taps Submit while another trade is mid-flight | `redis.set(trade:lock:{userId})` NX 150s (existing pattern from `executeTrade`) | "Another trade in progress. Wait." |
| Tx fails on chain (Phoenix reject) | `toBotError` mapping | "Submit failed: <reason>. Try again." — pending state cleared via `clearPending` |
| Helius Sender returns success but block height exceeded | `pollConfirmation` throws | `BLOCKHASH_EXPIRED` → retry-safe label shown |
| Cancel-by-index race: rung already gone (flip / triggered) | service check before tx | `TPSL_NOT_FOUND` → "That level isn't active anymore" + refresh manager |
| User in isolated-only market (GOLD etc) | existing `isIsolatedOnly` guard in trade preflight | We never get here from `/positions` because positions only exist on cross today; if isolated arrives later, gate at manager entry |
| Multiple positions same symbol different subaccounts | `getPositionConditionals` filters by `subaccountIndex: 0` + `positionSide` | For isolated v2: pass `subaccountIndex` through (defer) |
| Rate-limit (5 orders/min) hit | `checkOrderRateLimit` on every `tpsl:go` / `tpsl:rmgo` / `tpsl:clrgo` | "Too many orders. Wait a minute." |
| User not activated | `requireActivation(ctx)` on the open-manager entry | Standard activation prompt |
| Phoenix returns 5xx during cancel | `withRetry` already wraps; if it bubbles → `toBotError` | Standard error UI; user can retry |
| Old `editsl:` / `edittp:` deep-link still in chat history | grammY's unmatched-callback handler logs warning | Add forwarding handlers for one release: `editsl:` → `tpsl:open:sl:` to avoid dead buttons in user history |

---

## 8. Migration / staging

1. **Phase 1 — service layer only.** Land `src/services/phoenix/conditional.ts` + tests. Keep old code paths in `trade.ts` working. CI green.
2. **Phase 2 — wire auto-TP/SL.** Replace the block in `src/bot/commands/long.ts` to use the new service. Single tx (PDA init + TP + SL) instead of three. Test by opening a trade with `autoTpPct: 5` set.
3. **Phase 3 — UI swap.** Add `src/bot/commands/tpsl.ts`. Register it. Update `positions.ts` keyboard + detail text. Delete `settp.ts` / `setsl.ts`. Add legacy callback shims (`editsl:` → forward to new) for one release.
4. **Phase 4 — cleanup.** Remove `setTpSl` and `cancelStopLoss` from `trade.ts`. Remove the `takeProfit`/`stopLoss` scalar fields from `PhoenixPosition` and update `position.ts` mapping. Remove the WS `tpsl_flip` symbol check (still keep the alert — just stop comparing the old single-price field).

Each phase is independently shippable behind a feature flag `TPSL_V2_ENABLED` if needed, but probably not worth the flag overhead.

---

## 9. Tests

Unit (`tests/unit/services/conditional.test.ts`):

- `parseConditionalId` round-trips `ctp-7-3-gt`, `csl-12-0-lt`, rejects `ctp-7-3-zz`, `ctp-7--1-gt`, `weird-id`
- `resolveSize` for `full / lots / tokens / percent` with positionLots = `1_145_000` and `baseLotsDecimals = 5`
- `validateTriggerPrice` truth table (4 sides × 4 wrongness modes × liq cutoff)
- `validateSizes` rejects when remaining + new > positionLots
- multi-level + `full` mix throws `TPSL_FULL_WITH_MULTI`
- `computeMarketExecutionTicks` direction-correct: Ask = trigger×0.9, Bid = trigger×1.1
- direction map: `(leg, side) → isGreater` matches Phoenix doc table

Integration (`tests/integration/tpsl.test.ts` — devnet keypair via `TEST_KEYPAIR`):

- Open a SOL long with `TEST_KEYPAIR`, set ladder (TP +5%@50%, TP +10%@50%), assert two rungs in `getPositionConditionals` with correct sizes
- Edit rung 1: cancel + re-place at +6% in single tx, assert idx changes
- Cancel-all, assert empty ladder
- Capacity test: place 8 rungs, attempt 9th → `TPSL_CAPACITY`

Manual smoke tests (script in `scripts/`):

- `scripts/smoke-tpsl.ts` — open position, set TP, list, edit, remove, list, close. Exits non-zero on any mismatch.

---

## 10. Open questions

1. **`tickToUsd` derivation** — confirm the Rise SDK helper (likely `ticksToPriceUsd`). If absent, vendor a small util matching the SDK's `priceUsdToTicks` inverse and unit-test against known SOL ticks.
2. **`asset_id` field on `getMarket`** — verify the SDK's `ExchangeMarketConfig` exposes `assetId`. If named differently, adjust `parseConditionalId`.
3. **HTTP `cancelConditionalOrder` returns `InstructionsWithAccountsAndData[]`** — cast/adapt to the `AnyInstruction` type our `dispatchInstructions` accepts. Spot-check shape against `client.ixs.*` outputs we already use.
4. **WS `traderState` delta** — when a TP fires, we'll see a position-size delta. The `tpsl_flip` alert already covers full flips; should we add a `tp_filled` / `sl_filled` alert that names the rung? Defer.
5. **Should we re-validate liquidation distance** at every preset render (preset list could become invalid if liq moves closer)? — yes for SL; presets that would set SL below liq just get omitted from the keyboard.

---

## 11. Acceptance checklist

- [x] `/settp`, `/settl` commands removed (files deleted, never registered in `setMyCommands`)
- [x] Tapping `🎯 Set TP` on positions screen opens the new manager (callback wired via `positionKeyboard`)
- [x] PDA is created on the user's first-ever TP, no extra tap required (lazy `buildCreateConditionalOrdersAccount` in `buildSetPositionTpSlIxs`)
- [x] Setting both TP and SL on auto-open uses ONE transaction (combined `setPositionTpSl({tp, sl})` in `executeTrade`)
- [x] Removing rung 1 of a 2-rung ladder cancels by index (parsed from `ctp-{assetId}-{idx}-{gt|lt}`), leaves rung 2 intact
- [x] Position flip → manager shows empty state (Phoenix invalidates conditional orders server-side; we re-fetch on each manager open)
- [x] Telegram callback strings all ≤ 64 bytes (`tests/unit/bot/tpsl-callbacks.test.ts`, 18 worst-case patterns)
- [x] `executeTrade` auto-TP/SL no longer issues a sequential loop of `dispatchInstruction` (single `setPositionTpSl` call)
- [x] All UI-reachable edge cases produce friendly `BotError`-rendered messages, not stack traces
- [ ] Devnet validation pending (Phase 2.4–2.6, 3.4, 5.3, 7.1–7.10)
- [ ] Ladder of 3 rungs at 33/33/34 % — wire-level test pending devnet

---

## 12. TODO — task breakdown

Detailed checklist organized by phase. Each leaf task should be a single PR-sized commit.
Markers: **(R)** research/verification, **(C)** code change, **(T)** test, **(D)** docs/cleanup.

### Phase 0 — Research & spike (no production code) ✅

**Goal:** retire the 5 open questions in §10 before writing real code.

- [x] **(R)** 0.1 ticks→USD: no helper. Formula confirmed: `price_usd = ticks * tickSize * 10^(baseLotsDecimals - 6)` (USDC quote, 6 decimals).
- [x] **(R)** 0.2 `ExchangeMarketConfig.assetId: number` ✓ confirmed at SDK index.d.ts:160.
- [x] **(R)** 0.3 `cancelConditionalOrder` returns `Promise<InstructionsWithAccountsAndData[]>`. Compatible with `dispatchInstructions` after cast.
- [x] **(R)** 0.4 `ExchangeMarketConfig.marketPubkey: string` ✓ — Phoenix server-side uses it; we don't need to pass it ourselves to the HTTP API.
- [x] **(R)** 0.5 `Side.Ask` long-close, `Side.Bid` short-close ✓ (matches existing trade.ts).
- [x] **(R)** 0.6 `TraderStatePositionRow` carries `conditionalTakeProfitTriggers[]`, `conditionalStopLossTriggers[]` per docs.
- [x] **(R)** 0.7 `buildCreateConditionalOrdersAccount` capacity is `number` (u8 under the hood). Default 8 confirmed via vulcan.
- [x] **(R)** 0.8 `basePositionLots: string` is signed ("-N" for shorts) per `TraderStatePositionRow`.
- [x] **(D)** 0.9 Findings documented inline above. Also: `PhoenixClient.pda` (not `addresses`); `client.pda.getTraderAddress({authority, traderPdaIndex, subaccountIndex})`; `client.pda.getConditionalOrdersAddress({traderAccount})`.

### Phase 1 — Service layer (`src/services/phoenix/conditional.ts`) ✅

All sub-phases complete. 127 unit tests pass (52 new in `conditional.test.ts`).
`pnpm exec tsc --noEmit` clean.

- [x] 1A.1–1A.6 Types, primitives, tick math, ID parser
- [x] 1B.1–1B.6 Validation (price, mode, size, sum, rungs)
- [x] 1C.1–1C.4 Read path via `getTraderStateSnapshot`
- [x] 1D.1–1D.5 Write path: PDA init cache, place ix builder, cancel descriptors, atomic ix bundling
- [x] 1E.1–1E.2 Cancel ix builders (per-rung + filter "tp"|"sl"|"both")
- [x] 1F.1–1F.2 `setPositionTpSl`, `cancelPositionConditional`, `cancelAllPositionConditionals` exported from `trade.ts`; old `setTpSl` marked `@deprecated`
- [x] 1G.1–1G.9 Unit tests + CI green

### Phase 2 — Auto-TP/SL on trade open (low-risk wiring) ✅

- [x] **(C)** 2.1 Auto-TP/SL block in `src/bot/commands/long.ts:executeTrade` routed through `setPositionTpSl` with `{ kind: "full" }` size, combined-leg single call.
- [x] **(C)** 2.2 `src/bot/commands/short.ts` shares the same `executeTrade` from long.ts — no separate copy.
- [x] **(C)** 2.3 Old `setTpSl` import removed; `setPositionTpSl` imported.
- [ ] **(T)** 2.4 Manual devnet validation pending (cannot run here).
- [ ] **(T)** 2.5 Manual devnet validation pending.
- [ ] **(T)** 2.6 Manual Solscan inspection pending.

### Phase 3 — Position screen integration (read-only first) ✅

- [x] **(C)** 3.1 `PhoenixPosition` extended with `tpRungs?`, `slRungs?`, `positionLots?`, `baseLotsDecimals?`; scalar `takeProfit`/`stopLoss` retained for back-compat.
- [x] **(C)** 3.2 Position detail screen fetches `getPositionConditionals` in parallel with `getTraderState` (kept `getTraderState` lean to avoid round-trip cost on list view).
- [x] **(C)** 3.3 `buildDetailText` now renders ladder via `summarizeRungs`. Keyboard switches to `tpsl:open:tp:...` / `tpsl:open:sl:...` with state-aware labels.
- [ ] **(T)** 3.4 Manual devnet validation pending.

### Phase 4 — TP/SL Manager UI (`src/bot/commands/tpsl.ts`) ✅

- [x] 4A.1–4A.9 Manager skeleton, ladder rendering, populated/empty states, keyboard wiring
- [x] 4B.1–4B.10 Add-rung wizard: price → size → confirm with mode toggle, atomic submit
- [x] 4C.1–4C.5 Row action sheet, per-rung edit (price/size/mode flip), remove
- [x] 4D.1–4D.2 Clear-all confirm + exec (single-tx batched)
- [x] 4E.1–4E.3 Text dispatcher rewired; old `editsl:`/`edittp:` branches removed
- [x] 4F.1–4F.2 Legacy callback shims (`editsl:`, `edittp:`) forward to new manager
- [x] 4G.3, 4G.5 Limit/Market star toggle; callback-length regression test (18 patterns ≤ 64 bytes)
- [x] 4H.1–4H.2 Tests in `tests/unit/bot/tpsl-callbacks.test.ts`

Notes:
- 4D.3 Replace-all collapsed: covered by Clear-all + Add path; explicit `tpsl:rep` not registered to avoid a redundant button.
- 4G.1, 4G.2, 4G.4 minor polish; can be revisited post-devnet test.

### Phase 5 — WS handler updates ✅

- [x] **(C)** 5.1 `tpsl_flip` detector still works (compares position side, unchanged).
- [x] **(C)** 5.2 Alert keyboard buttons in `src/workers/ws.ts:260-269` updated to `tpsl:open:sl:` / `tpsl:open:tp:`. Trade success-message buttons in `src/bot/commands/long.ts:547-548` also updated.
- [ ] **(T)** 5.3 Manual devnet validation pending.

### Phase 6 — Cleanup ✅

- [x] **(C)** 6.1 `src/bot/commands/settp.ts` deleted.
- [x] **(C)** 6.2 `src/bot/commands/setsl.ts` deleted.
- [x] **(C)** 6.3 `registerSetSl`/`registerSetTp` lines removed from `src/bot/commands/index.ts`.
- [ ] **(C)** 6.4 Legacy `editsl:` / `edittp:` shims KEPT for one release so dead buttons in chat history continue to work. Re-evaluate after first prod release.
- [x] **(C)** 6.5 `setTpSl`, `cancelStopLoss`, `TpSlParams`, `TpSlLevel` removed from `src/services/phoenix/trade.ts`. Unused SDK imports cleaned.
- [x] **(C)** 6.6 `takeProfit?` / `stopLoss?` scalar fields removed from `PhoenixPosition`.
- [x] **(C)** 6.7 Scalar `tpRaw`/`slRaw` mapping removed from `getTraderState`.
- [x] **(C)** 6.8 Old `editsl:` / `edittp:` text-dispatcher branches deleted from `src/bot/index.ts` (Phase 4).
- [x] **(D)** 6.9 `CLAUDE.md` updated with TP/SL section.
- [x] **(D)** 6.10 `COMMANDS.md` row reworded to reflect ladder-capable manager.

### Phase 7 — Integration tests + smoke ✅ (smoke landed; on-chain tests pending devnet env)

- [ ] **(T)** 7.1–7.10 Devnet on-chain tests require funded `TEST_KEYPAIR` + live position. Pending manual run.
- [x] **(C)** 7.11 `scripts/smoke-tpsl.ts` created. Runnable end-to-end demo: place ladder → edit → remove → clear-all. Typechecks via project tsconfig.

### Phase 8 — Documentation & release ✅

- [x] **(D)** 8.1 `CLAUDE.md` TP/SL section added.
- [x] **(D)** 8.2 `COMMANDS.md` row reworded.
- [ ] **(D)** 8.3 User-facing changelog — deferred to release time.
- [ ] **(D)** 8.4 PRD update — deferred (PRD already references ladder support generically).
- [x] **(D)** 8.5 §11 Acceptance checklist updated below.

### Phase 9 — Post-launch monitoring (first 72h) — pending live deploy

- [ ] **(R)** 9.1–9.4 Live-traffic items, deferred.

---

**Total: 9 phases, 11 sub-phases, ~115 leaf tasks.** Estimated 5–8 working days for one engineer end-to-end, dominated by Phase 4 UI (~40% of effort) and Phase 7 integration tests (~20%).
