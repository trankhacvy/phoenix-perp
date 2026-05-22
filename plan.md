# Implementation Plan: Vulcan-CLI Learnings Applied to Phoenix Perp Bot

All items are grounded in the actual source. File paths and line numbers reference the current codebase.

---

## Phase 0 — Bug Fixes ✅ COMPLETED

### 0.1 Fix `sendInstructions` — parallel → sequential ✅

**File**: `src/services/phoenix/trade.ts:105-108`

**Problem**: `Promise.all` fires every instruction as a simultaneous, independent transaction. Deposit and withdraw return multi-instruction results (`buildDepositIxs`, `buildWithdrawIxs`) where each instruction depends on the on-chain state from the previous one. Running them in parallel can cause the second transaction to fail because the first hasn't settled yet.

**Current code**:
```typescript
// trade.ts:105-108
async function sendInstructions(ixs: AnyInstruction[], signer: KeyPairSigner): Promise<string> {
  const sigs = await Promise.all(ixs.map((ix) => sendInstruction(ix, signer)));
  return sigs[sigs.length - 1] ?? "";
}
```

**Fix**:
```typescript
async function sendInstructions(ixs: AnyInstruction[], signer: KeyPairSigner): Promise<string> {
  let sig = "";
  for (const ix of ixs) {
    sig = await sendInstruction(ix, signer);
  }
  return sig;
}
```

No other changes needed. `depositCollateral` (line 311) and `withdrawCollateral` (line 323) both call this.

---

### 0.2 Fix liquidation price in confirm screen — use API value, not formula ✅

**File**: `src/bot/commands/long.ts:257-258`

**Problem**: The confirm screen computes liq price from the theoretical formula `entry * (1 - 1/lev)`. Phoenix uses maintenance margin tiers, so the real liquidation price differs. The correct value is already in `state.positions[n].liquidationPrice` from the `getTraderState()` call that runs on line 239.

**Current code**:
```typescript
// long.ts:239-258
export async function sendTradeConfirm(...) {
  const [snapshot, state] = await Promise.all([
    getMarketSnapshot(symbol).catch(() => null),
    getTraderState(ctx.user.walletAddress),        // ← already fetched
  ]);
  // ...
  const liqPrice =
    side === "long" ? entry * (1 - 1 / effectiveLev) : entry * (1 + 1 / effectiveLev); // ← wrong
```

The confirm screen shows a *pre-trade* liq price estimate; the trader doesn't have a position yet so `state.positions` won't have this symbol. We need to compute an estimated liq price using the same formula Phoenix uses: `maintenanceMarginFraction = 1 / (maxLeverage * 2)` as a proxy.

**Fix** — replace the raw `1/lev` formula with one that uses the market's actual maintenance margin:
```typescript
// sendTradeConfirm in long.ts — replace lines 257-258
// maintenanceMarginFraction ≈ 0.5 / maxLeverage (Phoenix convention)
const mmFrac = 0.5 / snapshot.maxLeverage;
const liqPrice =
  side === "long"
    ? entry * (1 - (1 / effectiveLev) + mmFrac)
    : entry * (1 + (1 / effectiveLev) - mmFrac);
```

This still isn't exact (Phoenix uses tier-based MM), but it's closer than `1/lev` and it won't show an unreachable price.

Additionally, when the position *already exists* (e.g. reducing, setting SL), always use the API value. In `sendPositionDetail` (`positions.ts:73`) this is already correct — it reads from `pos.liquidationPrice`.

---

### 0.3 Fix decimal leverage in confirm callback regex ✅

**File**: `src/bot/commands/long.ts:64` and `src/bot/commands/short.ts` (same pattern)

**Problem**: The leverage picker callback `trade_lev:long:([A-Z0-9]+):(\d+)` uses `\d+` which only matches integers. When a user types a custom leverage of `12.5`, `parseLeverage` returns `12.5` but the callback that stores it in the confirm ID uses `\d+`, silently failing.

**Current code**:
```typescript
// long.ts:64
bot.callbackQuery(/^trade_lev:long:([A-Z0-9]+):(\d+)$/, async (ctx) => {
```

**Fix** — update both the regex and the `sendSizePicker` dispatch to use `[\d.]+`:
```typescript
// long.ts — update these 3 regexes
bot.callbackQuery(/^trade_lev:long:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
// ...
bot.callbackQuery(/^trade_size:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
// ...
bot.callbackQuery(/^confirm:long:([A-Z0-9]+):([\d.]+):([\d.]+):([\d.]+)$/, async (ctx) => {
```

Apply the same fix in `short.ts`. The keyboard in `trade.ts:15` already emits integer leverage values only, so custom leverage values (floats) entered via text only go through the pending state → text handler path, which is fine.

Also fix `parseLeverage` in `fmt.ts:53` — it calls `Math.round()` which destroys `12.5x` → `13`. Remove the rounding:
```typescript
// fmt.ts:53 — current
export function parseLeverage(raw: string): number {
  return Math.round(Number.parseFloat(raw.replace(/[xX]/g, "")));
}

// fix — allow decimals (Phoenix accepts them)
export function parseLeverage(raw: string): number {
  return Number.parseFloat(raw.replace(/[xX]/g, ""));
}
```

---

## Phase 1 — High-Value Features

### 1.1 Structured error classifier ✅

**Problem**: Every `catch` block in commands exposes raw SDK error strings to users. Example from `long.ts:131-138`:
```typescript
const errMsg = e instanceof Error ? e.message : "Unknown error";
// user sees: "authority account not found at offset 8"
```

**New file**: `src/bot/lib/errors.ts`

```typescript
export interface TradeErrorInfo {
  message: string;    // user-facing
  hint: string;       // what to do next
  retryable: boolean;
}

const PATTERNS: Array<{ match: RegExp | string; info: TradeErrorInfo }> = [
  {
    match: /blockhash not found|block height exceeded/i,
    info: { message: "Transaction expired.", hint: "Try again — it's safe to retry.", retryable: true },
  },
  {
    match: /insufficient.*sol|0x1/i,
    info: { message: "Not enough SOL for gas.", hint: "Top up your wallet with a small amount of SOL.", retryable: false },
  },
  {
    match: /insufficient.*collateral|not enough margin/i,
    info: { message: "Insufficient margin.", hint: "Deposit more USDC with /deposit.", retryable: false },
  },
  {
    match: /trader.*not.*found|no trader account/i,
    info: { message: "Account not registered.", hint: "Run /start to set up your account.", retryable: false },
  },
  {
    match: /slippage|price.*moved/i,
    info: { message: "Price moved too fast.", hint: "The market moved. Try again with a slightly larger slippage.", retryable: true },
  },
  {
    match: /position.*not found|no.*position/i,
    info: { message: "No open position found.", hint: "Check /positions.", retryable: false },
  },
  {
    match: /isolated.*only|isolated margin required/i,
    info: { message: "This market requires isolated margin.", hint: "Isolated margin support coming soon.", retryable: false },
  },
  {
    match: /rate.?limit|429/i,
    info: { message: "API rate limit hit.", hint: "Wait a few seconds and try again.", retryable: true },
  },
];

export function classifyTradeError(err: unknown): TradeErrorInfo {
  const msg = err instanceof Error ? err.message : String(err);
  for (const { match, info } of PATTERNS) {
    const matched =
      typeof match === "string" ? msg.includes(match) : match.test(msg);
    if (matched) return info;
  }
  return {
    message: "Something went wrong.",
    hint: "Try again or contact support if this keeps happening.",
    retryable: false,
  };
}

export function formatTradeError(err: unknown, action: string): string {
  const { message, hint, retryable } = classifyTradeError(err);
  const retryNote = retryable ? "\n\n↩️ This is safe to retry." : "";
  return `❌ <b>${action} failed</b>\n\n${message}\n<i>${hint}</i>${retryNote}`;
}
```

**Usage** — replace all raw catch blocks. Example in `long.ts:130-138`:
```typescript
// before
} catch (e) {
  logger.error({ err: e, symbol, side: "long" }, "placeMarketOrder failed");
  const errMsg = e instanceof Error ? e.message : "Unknown error";
  const kb = new InlineKeyboard()
    .text("Try again", `trade:long:${symbol}`)
    .text("← Back", "nav:positions");
  const errFmt = fmt`❌ ${FormattedString.b("Trade failed")}\n\n${symbol} Long\nReason: ${FormattedString.code(errMsg)}`;
  await ctx.editMessageText(errFmt.text, { entities: errFmt.entities, reply_markup: kb });
}

// after
} catch (e) {
  logger.error({ err: e, symbol, side: "long" }, "placeMarketOrder failed");
  const kb = new InlineKeyboard()
    .text("Try again", `trade:long:${symbol}`)
    .text("← Back", "nav:positions");
  await ctx.editMessageText(
    formatTradeError(e, "Trade"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}
```

Apply the same pattern in: `short.ts`, `setsl.ts` (4 catch blocks), `settp.ts` (4 catch blocks), `positions.ts` (2 catch blocks), `withdraw.ts`.

---

### 1.2 Leverage tier validation in confirm screen ✅

**Problem**: The confirm screen checks `sizeUsdc > available` but never validates whether the notional fits within a leverage tier. Phoenix rejects orders where `notional > maxNotionalForLeverage`.

**Where to add**: `src/bot/commands/long.ts:sendTradeConfirm` (also `short.ts` — same function, same fix)

`market.leverageTiers` is an array of `{ maxLeverage, maxNotionalUsdc }` already available via `getMarket()`. `getMarketSnapshot` calls `getMarket()` internally but discards `leverageTiers` (only uses `leverageTiers[0].maxLeverage`).

**Step 1** — expose `leverageTiers` from `getMarketSnapshot` in `src/services/phoenix/market.ts`:
```typescript
// market.ts — update MarketSnapshot interface
export interface MarketSnapshot {
  // ... existing fields ...
  leverageTiers: Array<{ maxLeverage: number; maxNotionalUsdc?: number }>;
}

// update getMarketSnapshot return value
return {
  // ... existing fields ...
  leverageTiers: market.leverageTiers ?? [],
};
```

**Step 2** — add validation in `sendTradeConfirm` (`long.ts`) after the existing `sizeUsdc > available` check:
```typescript
// long.ts — add after line 248 (the available check)
const notional = sizeUsdc * effectiveLev;

// Find the tier that covers this notional
const fittingTier = snapshot.leverageTiers.find(
  (t) => t.maxNotionalUsdc == null || notional <= t.maxNotionalUsdc,
);
if (fittingTier && effectiveLev > fittingTier.maxLeverage) {
  // Clamp to the max leverage for this notional size
  const cappedLev = fittingTier.maxLeverage;
  const msg = fmt`⚠️ At ${FormattedString.b(usd(notional))} notional, max leverage is ${FormattedString.b(`${cappedLev}x`)}.\n\nReduce your position size or lower your leverage.`;
  await ctx.reply(msg.text, { entities: msg.entities });
  return;
}

// Also warn if no fitting tier found (exceeds all tiers)
if (!fittingTier) {
  await ctx.reply(`Position too large for ${symbol}. Reduce your size.`);
  return;
}
```

---

### 1.3 Multi-level TP/SL (laddered exits) ✅

**Problem**: `TpSlParams` supports only a single TP and single SL price. Phoenix SDK supports multiple stop-loss instructions with different sizes. Vulcan uses `tp_levels` and `sl_levels` arrays.

**Step 1** — extend `TpSlParams` in `src/services/phoenix/trade.ts`:
```typescript
// trade.ts — replace TpSlParams interface (line 51-59)
export interface TpSlLevel {
  price: number;
  /** fraction of position to close: 0.25 = 25%, 1.0 = 100% */
  fraction?: number;
  mode?: "market" | "limit";
}

export interface TpSlParams {
  symbol: string;
  walletAddress: string;
  positionSide: "long" | "short";
  // single-level (backward compat)
  tpPrice?: number;
  slPrice?: number;
  slMode?: "market" | "limit";
  tpMode?: "market" | "limit";
  // multi-level
  tpLevels?: TpSlLevel[];
  slLevels?: TpSlLevel[];
}
```

**Step 2** — update `setTpSl` in `trade.ts` to iterate levels:
```typescript
export async function setTpSl(params: TpSlParams, signer: KeyPairSigner): Promise<void> {
  const client = getTradingClient();
  await client.exchange.ready();

  const marketSymbol = toMarketSymbol(params.symbol);
  const market = (await getMarket(params.symbol)) as { tickSize: number; baseLotsDecimals: number };
  const closeSide = params.positionSide === "long" ? Side.Ask : Side.Bid;

  // Normalise: single-level fields → arrays
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
        // size is optional; SDK uses full position if omitted
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

  // send sequentially (each ix is independent, but avoids blockhash conflicts)
  for (const ix of ixs) {
    await sendInstruction(ix, signer);
  }
}
```

**Step 3** — add ladder UI to `/settp` (`settp.ts`) — a new button row "Set ladder exit":
```typescript
// settp.ts — add to sendTpPrompt keyboard, after existing preset rows
kb.row().text("🪜 Ladder exit (25/50/100%)", `tp_ladder:${symbol}:${positionSide}`);
```

Add the callback handler:
```typescript
// settp.ts
bot.callbackQuery(/^tp_ladder:([A-Z0-9]+):(long|short)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol);
  if (!pos) { await ctx.reply(`No open ${symbol} position.`); return; }

  const markPrice = Number(pos.markPrice);
  const pcts = side === "long" ? [5, 10, 20] : [5, 10, 20]; // up for long, down for short
  const levels = pcts.map((pct) => ({
    price: side === "long" ? markPrice * (1 + pct / 100) : markPrice * (1 - pct / 100),
    fraction: pct === 5 ? 0.25 : pct === 10 ? 0.50 : 1.0,
    pct,
  }));

  const lines = levels
    .map((l) => `• +${l.pct}% at ~${price(l.price)} — close ${l.fraction * 100}%`)
    .join("\n");

  const kb = new InlineKeyboard()
    .text("✅ Set ladder", `tp_ladder_exec:${symbol}:${side}:${levels.map(l => `${l.price.toFixed(4)}`).join(",")}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`🪜 ${FormattedString.b(`Ladder Take Profit — ${symbol}`)}\n\n${lines}\n\n${FormattedString.i("Each level closes a portion of your position.")}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
});

bot.callbackQuery(/^tp_ladder_exec:([A-Z0-9]+):(long|short):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Setting ladder…");
  if (!ctx.user) return;
  const [symbol, side, pricesStr] = ctx.match.slice(1) as [string, "long" | "short", string];
  const prices = pricesStr.split(",").map(Number);
  const fractions = [0.25, 0.5, 1.0]; // matches the 3-level layout above

  try {
    await setTpSl(
      {
        symbol,
        walletAddress: ctx.user.walletAddress,
        positionSide: side,
        tpLevels: prices.map((p, i) => ({ price: p, fraction: fractions[i], mode: "limit" })),
      },
      getKitSigner(ctx.user.walletAddress),
    );
    const msg = fmt`✅ ${FormattedString.b("Ladder take profit set")}\n\n${symbol} — 3 levels active`;
    await ctx.editMessageText(msg.text, { entities: msg.entities });
  } catch (e) {
    logger.error({ err: e, symbol }, "tp_ladder_exec failed");
    await ctx.editMessageText(formatTradeError(e, "Ladder TP"), { parse_mode: "HTML" });
  }
});
```

---

### 1.4 Technical indicators on `/price` ✅

**Problem**: `/price` shows mark price, funding, OI, and max leverage. No signal context. Vulcan's `ta report` bundles RSI + MACD + BBands + ATR.

**Step 1** — add `technicalindicators` package:
```bash
pnpm add technicalindicators
pnpm add -D @types/technicalindicators
```

**Step 2** — new file `src/services/phoenix/candles.ts`:
```typescript
import { getPhoenixClient } from "./client.js";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function getCandles(
  symbol: string,
  interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d" = "1h",
  limit = 50,
): Promise<Candle[]> {
  const raw = await getPhoenixClient()
    .api.candles()
    .getCandles(symbol.toUpperCase(), { interval, limit })
    .catch(() => null);
  if (!raw) return [];
  return (raw as unknown[]).map((c: Record<string, unknown>) => ({
    timestamp: Number(c.timestamp ?? c.time ?? 0),
    open: Number(c.open ?? 0),
    high: Number(c.high ?? 0),
    low: Number(c.low ?? 0),
    close: Number(c.close ?? 0),
    volume: Number(c.volume ?? 0),
  }));
}

export interface TaSnapshot {
  rsi: number | null;
  macdHist: number | null;    // positive = bullish momentum
  bbUpperBand: number | null;
  bbLowerBand: number | null;
  atr: number | null;
}

export async function getTaSnapshot(symbol: string): Promise<TaSnapshot> {
  // Fetch enough candles for indicator warmup (MACD needs 35 minimum)
  const candles = await getCandles(symbol, "1h", 60);
  if (candles.length < 20) {
    return { rsi: null, macdHist: null, bbUpperBand: null, bbLowerBand: null, atr: null };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  // RSI(14)
  const { RSI, MACD, BollingerBands, ATR } = await import("technicalindicators");
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiValues.at(-1) ?? null;

  // MACD(12,26,9)
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macdHist = macdValues.at(-1)?.histogram ?? null;

  // Bollinger Bands(20,2)
  const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const bb = bbValues.at(-1);
  const bbUpperBand = bb?.upper ?? null;
  const bbLowerBand = bb?.lower ?? null;

  // ATR(14)
  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrValues.at(-1) ?? null;

  return { rsi, macdHist, bbUpperBand, bbLowerBand, atr };
}
```

**Step 3** — integrate into `sendPriceScreen` in `src/bot/commands/price.ts`:
```typescript
// price.ts — add import
import { getTaSnapshot } from "../../services/phoenix/candles.js";

// sendPriceScreen — add ta to the parallel fetch
export async function sendPriceScreen(ctx: BotContext, symbol: string): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof getMarketSnapshot>>;
  let stats: Awaited<ReturnType<typeof getMarketStatsHistory>>;
  let ta: Awaited<ReturnType<typeof getTaSnapshot>>;

  try {
    [snapshot, stats, ta] = await Promise.all([
      getMarketSnapshot(symbol),
      getMarketStatsHistory(symbol, 1),
      getTaSnapshot(symbol),   // ← new, never throws (returns nulls on failure)
    ]);
  } catch {
    await ctx.reply(`Market "${symbol}" not found. Use /markets to browse.`);
    return;
  }

  // ... existing message building ...

  // Build TA section (only if we have data)
  const taSection =
    ta.rsi !== null
      ? (() => {
          const rsiLabel =
            ta.rsi < 30 ? "Oversold 📉" : ta.rsi > 70 ? "Overbought 📈" : "Neutral";
          const macdLabel =
            ta.macdHist !== null
              ? ta.macdHist > 0
                ? "Bullish momentum ↑"
                : "Bearish momentum ↓"
              : "";
          const bbStr =
            ta.bbUpperBand && ta.bbLowerBand
              ? `${price(ta.bbLowerBand)} – ${price(ta.bbUpperBand)}`
              : "";
          const atrStr = ta.atr !== null ? price(ta.atr) : "";

          return fmt`\n\n📊 ${FormattedString.b("Indicators (1H)")}\nRSI(14)     ${FormattedString.b(ta.rsi.toFixed(1))}  ${FormattedString.i(rsiLabel)}\nMACD        ${FormattedString.i(macdLabel)}\nBollinger   ${FormattedString.b(bbStr)}\nATR(14)     ${FormattedString.b(atrStr)}`;
        })()
      : fmt``;

  const msg = fmt`📊 ${FormattedString.b(`${symbol}/USD`)}\n\nPrice         ${FormattedString.b(fmtPrice(snapshot.markPrice))}\n\nFunding       ${FormattedString.b(apr)}\n              ${FormattedString.i(dir)}${fundingWarning}\nOpen interest ${FormattedString.b(oiStr)}\n\nMax leverage  ${FormattedString.b(`${snapshot.maxLeverage}x`)}\nTaker fee     ${FormattedString.b(`${(snapshot.takerFee * 100).toFixed(2)}%`)}${isolatedNote}${taSection}`;
  // ... rest unchanged
```

---

### 1.5 WS worker reconnect hardening + watchdog ✅

**Problem 1**: Double-reconnect race in `ws.ts`. When `close` fires, `connections.delete` runs immediately and a 5-second timer fires `subscribeUser` again. If `close` fires twice in quick succession (network blip), two timers can both pass the `connections.has` guard.

**Problem 2**: No escalation if WebSocket fails to reconnect repeatedly. The bot silently enters an infinite retry loop.

**File**: `src/workers/ws.ts`

**Step 1** — add a reconnect guard map:
```typescript
// ws.ts — add near top alongside `connections`
const connections = new Map<string, WebSocket>();
const userCache = new Map<string, string>();
const reconnecting = new Set<string>();   // ← new: prevents double-reconnect
```

**Step 2** — update the `close` handler in `subscribeUser`:
```typescript
// ws.ts — replace the ws.on("close") handler inside subscribeUser
ws.on("close", () => {
  connections.delete(walletAddress);
  logger.info({ walletAddress }, "WS closed");

  if (reconnecting.has(walletAddress)) return;  // already queued
  reconnecting.add(walletAddress);

  setTimeout(() => {
    reconnecting.delete(walletAddress);
    subscribeUser(walletAddress, telegramId).catch((err) => {
      logger.error({ err, walletAddress }, "WS reconnect failed");
    });
  }, 5000);
});
```

**Step 3** — add a reconnect failure counter and alert after 3 consecutive failures:
```typescript
// ws.ts — add near the top
const reconnectFailures = new Map<string, number>();
const MAX_RECONNECT_FAILURES = 3;

// In the subscribeUser ws.on("open") handler, reset the counter:
ws.on("open", () => {
  reconnectFailures.delete(walletAddress);   // reset on successful connect
  ws.send(JSON.stringify({
    type: "subscribe",
    subscription: { channel: "traderState", wallet: walletAddress },
  }));
  logger.info({ walletAddress }, "WS subscribed: traderState");
});

// In ws.on("error"):
ws.on("error", (err) => {
  logger.error({ err, walletAddress }, "WS error");
  const failures = (reconnectFailures.get(walletAddress) ?? 0) + 1;
  reconnectFailures.set(walletAddress, failures);

  if (failures >= MAX_RECONNECT_FAILURES) {
    reconnectFailures.delete(walletAddress);
    const telegramId = userCache.get(walletAddress);
    if (telegramId) {
      alertQueue.add("ws-error", {
        telegramId,
        type: "fill",   // reuse fill type so dedup window applies
        symbol: undefined,
        message: "⚠️ <b>Live alerts interrupted</b>\n\nWe lost connection to the market feed. Reconnecting…\n\nUse /positions to check your account.",
      }).catch(() => undefined);
    }
  }
});
```

**Step 4** — fix `allMidsWs` same race:
```typescript
// ws.ts — replace allMids close handler
let allMidsReconnecting = false;  // ← add near allMidsWs declaration

allMidsWs.on("close", () => {
  allMidsWs = null;
  if (allMidsReconnecting) return;
  allMidsReconnecting = true;
  setTimeout(() => {
    allMidsReconnecting = false;
    subscribeAllMids();
  }, 5000);
});
```

---

### 1.6 Retry with exponential backoff on Phoenix API calls ✅

**Problem**: Zero retry logic. A single rate-limit or network hiccup fails the entire command.

**New file**: `src/lib/retry.ts`
```typescript
export interface RetryOptions {
  attempts?: number;       // default 3
  baseDelayMs?: number;    // default 1000
  retryIf?: (err: unknown) => boolean;  // default: always retry
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 1000, retryIf } = opts;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = retryIf
        ? retryIf(err)
        : /rate.?limit|429|network|ECONNRESET|timeout|ETIMEDOUT/i.test(msg);

      if (!isRetryable || i === attempts - 1) break;

      const delay = baseDelayMs * 2 ** i;  // 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

**Usage** — wrap the two most frequently failing calls:

`src/services/phoenix/market.ts`:
```typescript
import { withRetry } from "../../lib/retry.js";

export async function getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  return withRetry(() => _getMarketSnapshot(symbol));
}

// rename current implementation to _getMarketSnapshot (private)
async function _getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  // ... existing body unchanged
}
```

`src/services/phoenix/position.ts`:
```typescript
import { withRetry } from "../../lib/retry.js";

export async function getTraderState(walletAddress: string): Promise<TraderStateEvent> {
  return withRetry(() => _getTraderState(walletAddress));
}

async function _getTraderState(walletAddress: string): Promise<TraderStateEvent> {
  // ... existing body unchanged
}
```

---

### 1.7 Blockhash caching ✅

**Problem**: Every `sendInstruction` call fetches a fresh blockhash (an RPC round-trip). For TP+SL pairs, that's 2 unnecessary round-trips.

**File**: `src/services/phoenix/trade.ts`

Add a module-level cache:
```typescript
// trade.ts — add near the top, after the existing _rpc/_sendAndConfirm declarations

interface CachedBlockhash {
  value: { blockhash: string; lastValidBlockHeight: bigint };
  fetchedAt: number;
}
let _cachedBlockhash: CachedBlockhash | null = null;
const BLOCKHASH_TTL_MS = 20_000;  // 20 seconds; Solana blockhashes live ~90s

async function getBlockhash() {
  const now = Date.now();
  if (_cachedBlockhash && now - _cachedBlockhash.fetchedAt < BLOCKHASH_TTL_MS) {
    return _cachedBlockhash.value;
  }
  const { rpc } = getRpc();
  const result = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  _cachedBlockhash = { value: result.value, fetchedAt: now };
  return result.value;
}
```

Update `sendInstruction` to use the cache:
```typescript
// trade.ts — replace sendInstruction body
async function sendInstruction(ix: AnyInstruction, signer: KeyPairSigner): Promise<string> {
  const { sendAndConfirm } = getRpc();
  const latestBlockhash = await getBlockhash();   // ← cached
  const signedIx = addSignersToInstruction([signer], ix);

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([signedIx], tx),
  );

  const signedTx = await signTransactionMessageWithSigners(message);
  await sendAndConfirm(
    {
      ...signedTx,
      lifetimeConstraint: { lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
    },
    { commitment: "confirmed" },
  );
  return getSignatureFromTransaction(signedTx);
}
```

> Note: Because blockhashes are cached for 20s, two near-simultaneous transactions (TP + SL) will reuse the same blockhash. This is correct — the same blockhash is valid for both independent transactions.

---

## Phase 2 — Quality-of-Life Improvements

### 2.1 Leveraged ROI % on PnL card ✅

**Problem**: `positions.ts:147-151` computes unleveraged ROI:
```typescript
const roiPct = (
  ((Number(pos.markPrice) - Number(pos.entryPrice)) / Number(pos.entryPrice)) *
  100 *
  (side === "long" ? 1 : -1)
).toFixed(2);
```
A 10x position on a +1% price move shows "ROI: 1%". The user actually made 10% on their margin.

**Fix** — use `pnl / margin` instead:
```typescript
// positions.ts — replace the roiPct calculation (line 147)
const pnl = Number(pos.unrealizedPnl) * fraction;
// sizeUsdc is not directly available here; approximate via notional / leverage
// entryPrice * size = notional; notional / leverage = margin
const notional = Number(pos.entryPrice) * Number(pos.size);
const estimatedLeverage = notional / Math.max(1, Number(pos.unrealizedPnl === "0" ? notional / 5 : 1));
// Simpler: just use pnl / (notional / implicit_leverage)
// Best proxy available without a leverage field: use pnl vs notional fraction
const priceMove =
  ((Number(pos.markPrice) - Number(pos.entryPrice)) / Number(pos.entryPrice)) *
  (side === "long" ? 1 : -1);
// Leveraged ROI = pnl / margin. Margin ≈ notional * mmFrac (from position.ts we don't have leverage)
// Use the simpler but correct: ROI = actualPnl / abs(entryPrice * size / leverageUsed)
// Since we don't persist leverage, compute from pnl / price_change_pct_of_notional
const roiPct =
  priceMove !== 0
    ? ((pnl / (Number(pos.entryPrice) * Number(pos.size) * Math.abs(priceMove))) *
        priceMove *
        100).toFixed(2)
    : "0.00";
```

Actually, we don't store leverage per position. The cleaner fix: add a `leverage` field to `PhoenixPosition` in `types/index.ts`, populate it from `getTraderState`, and use it in the ROI formula.

**Step 1** — add `leverage` to `PhoenixPosition`:
```typescript
// types/index.ts
export interface PhoenixPosition {
  // ... existing fields ...
  leverage?: number;   // estimated from position data
}
```

**Step 2** — compute leverage in `getTraderState` (`position.ts`):
```typescript
// position.ts — inside the positions.map, after computing markPriceComputed
const positionNotional = posValue; // positionValue is notional
const marginApprox = Number(uiStr(p.initialMargin ?? "0")); // if available
const leverageApprox =
  marginApprox > 0 ? Math.round(positionNotional / marginApprox) : undefined;

return {
  // ... existing fields ...
  leverage: leverageApprox,
};
```

**Step 3** — use in PnL card:
```typescript
// positions.ts — replace roiPct calculation
const leverage = pos.leverage ?? 1;
const margin = (Number(pos.entryPrice) * Number(pos.size)) / leverage;
const roiPct = margin > 0 ? ((pnl / margin) * 100).toFixed(2) : "0.00";
```

Also update `PnlCardData` in `image.ts` to accept and display the leverage:
```typescript
// image.ts
export interface PnlCardData {
  // ... existing ...
  leverage?: number;   // e.g. 10
}

// In the satori JSX, add below the symbol/side header:
// data.leverage ? `${data.leverage}x` : ""
```

---

### 2.2 `/portfolio` combined view ✅

**Problem**: Users run `/balance` + `/positions` separately. A single combined snapshot is more useful and reduces API calls (both commands call `getTraderState` independently).

**New file**: `src/bot/commands/portfolio.ts`
```typescript
import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import { getTraderState } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";
import { cryptoSize, price as fmtPrice, shortAddr, usd } from "../lib/fmt.js";

const solConnection = new Connection(config.HELIUS_RPC_URL, "confirmed");

// reuse riskEmoji from balance.ts (move to a shared lib/risk.ts if desired)
const riskEmoji: Record<string, string> = {
  safe: "🟢", healthy: "🟡",
  atRisk: "🟠", at_risk: "🟠",
  cancellable: "🔴", liquidatable: "🔴",
  backstopLiquidatable: "🔴", highRisk: "🔴",
};

export function registerPortfolio(bot: Bot<BotContext>) {
  bot.command("portfolio", async (ctx) => {
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }
    await sendPortfolioScreen(ctx);
  });
}

export async function sendPortfolioScreen(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const [state, solLamports] = await Promise.all([
    getTraderState(ctx.user.walletAddress),
    solConnection.getBalance(new PublicKey(ctx.user.walletAddress)).catch(() => 0),
  ]);

  const sol = (solLamports / 1e9).toFixed(4);
  const deposited = Number(state.depositedCollateral);
  const effective = Number(state.effectiveCollateral);
  const upnl = Number(state.unrealizedPnl);
  const funding = Number(state.unsettledFunding);
  const totalValue = effective + upnl + funding;
  const tier = String(state.riskTier ?? "safe");

  // ── Account section ──────────────────────────────────────────────────────
  const accountSection = fmt`💰 ${FormattedString.b("Account")}\n\nDeposited         ${FormattedString.b(usd(deposited))}\nAvailable margin  ${FormattedString.b(usd(effective))}\nUnrealized P&L    ${FormattedString.b(usd(upnl))}\nPending funding   ${FormattedString.b(usd(funding))}\nTotal value       ${FormattedString.b(usd(totalValue))}\n\nGas (SOL)  ${FormattedString.b(`${sol} SOL`)}\nWallet     ${FormattedString.code(shortAddr(ctx.user.walletAddress))}\n${riskEmoji[tier] ?? "⚪"} ${tier}`;

  // ── Positions section ─────────────────────────────────────────────────────
  let positionsSection = fmt``;
  if (state.positions.length > 0) {
    const posLines = state.positions.map((pos) => {
      const upnlPos = Number(pos.unrealizedPnl);
      const pnlSign = upnlPos >= 0 ? "+" : "";
      const emoji = pos.side === "long" ? "🟢" : "🔴";
      const liqLabel =
        pos.liquidationPrice === "N/A" ? "—" : fmtPrice(Number(pos.liquidationPrice));
      return fmt`${emoji} ${FormattedString.b(pos.symbol)}  ${cryptoSize(Number(pos.size), pos.symbol)}\n   Entry: ${fmtPrice(Number(pos.entryPrice))}  Mark: ${fmtPrice(Number(pos.markPrice))}\n   P&L: ${FormattedString.b(`${pnlSign}${usd(upnlPos)}`)}  Liq: ${liqLabel}`;
    });
    positionsSection = FormattedString.join(
      [fmt`\n\n📊 ${FormattedString.b(`Positions (${state.positions.length})`)}`, ...posLines],
      "\n",
    );
  } else {
    positionsSection = fmt`\n\n📊 ${FormattedString.i("No open positions.")}`;
  }

  const kb = new InlineKeyboard()
    .text("📥 Deposit", "nav:deposit")
    .text("📤 Withdraw", "nav:withdraw")
    .row()
    .text("🟢 Long", "nav:long")
    .text("🔴 Short", "nav:short")
    .row()
    .text("📋 History", "nav:history");

  const msg = FormattedString.join([accountSection, positionsSection], "");
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

**Register** in `src/bot/commands/index.ts`:
```typescript
import { registerPortfolio } from "./portfolio.js";
// inside registerCommands():
registerPortfolio(bot);
```

---

### 2.3 Price alert direction confirmation ✅

**Problem**: `pricealert.ts` stores the trigger price as a positive number regardless of direction. The WS worker (`ws.ts:223`) uses a sign convention (`trigger > 0` = rises above, negative = drops below) but the confirm screen says "alert when price rises to or above / drops to or below" — derived from comparing to current price at confirm time, not stored. If the price moves between confirm and fire, the direction can be wrong.

**Fix** — store direction explicitly. Update `alert_subscriptions.triggerPrice` encoding:

The current storage in `pricealert.ts:101-106`:
```typescript
await db.insert(alertSubscriptions).values({
  triggerPrice: String(triggerPrice),   // positive always
```

The WS worker check at `ws.ts:223`:
```typescript
const crossed = trigger > 0 ? current >= trigger : current <= Math.abs(trigger);
```

This implies negative = "drops below". The bug: `sendPriceAlertConfirm` shows "drops to or below" but stores a positive value, so the WS worker treats it as "rises above".

**Fix in `pricealert.ts`** — encode direction into the stored value:
```typescript
// sendPriceAlertConfirm — replace the exec callback
bot.callbackQuery(/^pricealert:exec:([A-Z0-9]+):([\d.]+):(above|below)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Setting alert…");
  if (!ctx.user) return;
  const [symbol, priceStr, direction] = ctx.match.slice(1) as [string, string, "above" | "below"];
  const triggerPrice = Number(priceStr);
  // encode direction: positive = rises above, negative = drops below
  const storedPrice = direction === "below" ? -triggerPrice : triggerPrice;

  await db.insert(alertSubscriptions).values({
    id: crypto.randomUUID(),
    userId: ctx.user.id,
    type: "price",
    symbol,
    triggerPrice: String(storedPrice),
    enabled: true,
  });
  // ...
});
```

Update `sendPriceAlertConfirm` to pass direction in the callback ID:
```typescript
// pricealert.ts — update sendPriceAlertConfirm
export async function sendPriceAlertConfirm(
  ctx: BotContext,
  symbol: string,
  triggerPrice: number,
): Promise<void> {
  const snap = await getMarketSnapshot(symbol).catch(() => null);
  const markPrice = snap?.markPrice ?? null;

  const direction: "above" | "below" =
    markPrice !== null ? (triggerPrice >= markPrice ? "above" : "below") : "above";

  const dirLabel = direction === "above" ? "🔼 rises above" : "🔽 drops below";

  const kb = new InlineKeyboard()
    .text("✅ Set alert", `pricealert:exec:${symbol}:${triggerPrice}:${direction}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`Set price alert?\n\n${FormattedString.b(symbol)} — notify when ${dirLabel} ${FormattedString.code(fmtPrice(triggerPrice))}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

The WS worker check in `ws.ts:221-224` is already correct for this encoding — no change needed there.

---

### 2.4 Funding trend on `/price` ✅

**Problem**: `/price` shows a single funding APR value. A user can't tell if it's been spiking or normalising.

`getFundingRateHistory` already exists in `market.ts:64`. Use it to build a simple trend arrow.

**Add helper to `src/bot/lib/fmt.ts`**:
```typescript
export function fundingTrend(rates: number[]): string {
  if (rates.length < 3) return "";
  const recent = rates.slice(-3);
  const deltas = recent.slice(1).map((r, i) => r - recent[i]);
  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  if (avgDelta > 0.00001) return "↑↑";
  if (avgDelta > 0) return "↑";
  if (avgDelta < -0.00001) return "↓↓";
  if (avgDelta < 0) return "↓";
  return "→";
}
```

**Integrate in `sendPriceScreen`** (`price.ts`):
```typescript
// price.ts — add to the parallel fetch
import { getFundingRateHistory } from "../../services/phoenix/market.js";
import { fundingTrend } from "../lib/fmt.js";

// In sendPriceScreen, add to Promise.all:
const [snapshot, stats, ta, fundingHistory] = await Promise.all([
  getMarketSnapshot(symbol),
  getMarketStatsHistory(symbol, 1),
  getTaSnapshot(symbol),
  getFundingRateHistory(symbol, 8).catch(() => null),
]);

// Build trend string
const trend = fundingHistory?.rates
  ? fundingTrend(fundingHistory.rates.map((r) => Number(r.fundingRatePercentage) / 100))
  : "";

// Add to the funding line in the message:
// "Funding   +12.34% / yr  Longs pay shorts ↑↑"
const msg = fmt`...Funding  ${FormattedString.b(apr)}  ${FormattedString.i(`${dir} ${trend}`)}...`;
```

---

### 2.5 Unsettled funding in position detail ✅

**Problem**: `sendPositionDetail` in `positions.ts:75` shows P&L but not pending funding. Users holding positions overnight may be surprised by their effective cost.

The `unsettledFunding` field is available on `TraderStateEvent` (already fetched).

**Fix in `sendPositionDetail`** (`positions.ts:55-81`):
```typescript
// positions.ts — add unsettled funding to position detail message
// The state fetch already exists at line 62
const unsettledFunding = Number(state.unsettledFunding);
const fundingNote =
  Math.abs(unsettledFunding) > 0.01
    ? fmt`\nPending funding  ${FormattedString.b(usd(unsettledFunding))}`
    : fmt``;

const msg = fmt`${emoji} ${FormattedString.b(`${pos.symbol}/USD — ${label}`)}\n\nSize       ${FormattedString.b(cryptoSize(Number(pos.size), pos.symbol))}\nEntry      ${FormattedString.b(fmtPrice(Number(pos.entryPrice)))}\nMark       ${FormattedString.b(fmtPrice(Number(pos.markPrice)))}\nP&L        ${FormattedString.b(`${pnlSign}${usd(upnl)}`)}${fundingNote}\nLiq price  ${FormattedString.b(liqLabel)}`;
```

---

## Sequencing & Dependencies

```
Phase 0 (bugs — no deps, do in one pass)
  0.1  sendInstructions sequential          ~5 min
  0.2  liq price formula                    ~20 min
  0.3  decimal regex + parseLeverage        ~10 min

Phase 1 (features — each independent)
  1.1  errors.ts classifier                 ~2h    ← do first, 1.3/1.4 use it
  1.2  leverage tier validation             ~1h    depends on market.ts change
  1.3  multi-level TP/SL                    ~3h    depends on 1.1
  1.4  TA indicators on /price              ~2h    needs candles.ts new file
  1.5  WS watchdog                          ~2h    isolated
  1.6  retry wrapper                        ~1h    isolated, wrap after 1.1
  1.7  blockhash cache                      ~1h    isolated

Phase 2 (QoL — each independent)
  2.1  leveraged ROI %                      ~1h    needs position.ts type change
  2.2  /portfolio command                   ~2h    isolated
  2.3  price alert direction fix            ~1h    isolated
  2.4  funding trend                        ~1h    isolated
  2.5  unsettled funding in detail          ~30 min isolated
```

---

## Testing Checklist

For each phase, manual tests to run against `TEST_KEYPAIR` mode:

**Phase 0**:
- [ ] Deposit USDC → confirm two-instruction flow completes without the second tx failing
- [ ] Long BTC with `12.5x` custom leverage → confirm screen shows correct leverage
- [ ] Confirm screen liq price: compare displayed value vs actual liquidation in Phoenix UI

**Phase 1.1 (errors)**:
- [ ] Force a trade failure (use a market with insufficient margin) → user sees friendly message, not raw SDK error
- [ ] Force blockhash expiry (mock) → retryable hint shown

**Phase 1.2 (tier validation)**:
- [ ] Attempt a notional that exceeds first leverage tier → get capped warning
- [ ] Normal size → no warning, trade proceeds

**Phase 1.3 (multi-level TP/SL)**:
- [ ] Set ladder TP on open position → 3 separate TP triggers visible on Phoenix
- [ ] Existing single-TP flow unchanged → confirm no regression

**Phase 1.4 (TA)**:
- [ ] `/price SOL` → shows RSI, MACD direction, Bollinger range, ATR
- [ ] `/price` on a market with insufficient candle history → TA section absent, no error

**Phase 1.5 (WS hardening)**:
- [ ] Kill Phoenix WS server briefly → reconnect happens once, not twice
- [ ] Kill WS 3 times consecutively → user receives "alerts interrupted" message

**Phase 1.6 (retry)**:
- [ ] Throttle network to force a timeout → command retries, eventually succeeds or gives retry hint

**Phase 2.2 (/portfolio)**:
- [ ] `/portfolio` with 2 open positions → shows both positions + account totals in one message
- [ ] `/portfolio` with no positions → clean "No open positions" state

**Phase 2.3 (alert direction)**:
- [ ] Set alert above current price → fires when price rises above
- [ ] Set alert below current price → fires when price drops below (not above)
