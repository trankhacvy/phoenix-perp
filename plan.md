# Plan — Re-implement the real-time WebSocket alert layer (on the Rise SDK WS client)

Status: design / not yet implemented. Grounded in current source, the official Phoenix WS docs, `scripts/ws-probe.ts` results (wallet `HiYGtw…`, May 2026), and the Rise SDK type defs in `node_modules/@ellipsis-labs/rise/dist/index.d.ts`.

> **Update:** the original draft hand-rolled raw `ws` sockets. We now base the plan on the **Rise SDK's managed WS client** (`createPhoenixWsClient`), which is already a dependency. It removes both root-cause bugs by construction (typed payloads + correct subscribe frames), multiplexes everything over one connection (kills the 500-socket cap), and ships channels we'd otherwise have to discover (`markPrice`, `marketStats`, `notifications`, typed `tradeHistory`).

---

## 1. Why we're doing this (root cause recap)

Everything routed through `src/workers/ws.ts → handleTraderStateEvent` is dead:

- **Bug A — wrong subscribe shape.** We send `{ channel:"traderState", wallet }`. Live server rejects (`missing field 'authority', 400`). Correct: `{ channel:"traderState", authority, traderPdaIndex }`.
- **Bug B — wrong payload assumption.** `JSON.parse(raw) as TraderStateEvent`, then evaluators read `event.riskTier`, `event.positions[].markPrice/unrealizedPnl/liquidationPrice`. The real payload has none of those (positions nested under `subaccounts[]` with raw lots) and is **price-blind** (snapshots byte-identical while price moves; ~15s heartbeat).

Affected (all broken): risk-tier/liquidation, position-flip (`tpsl_flip`), Guardian (all rules), wallet-monitor/copy-trade, referral accrual. Working (independent channels): price alerts (`allMids` in `price-alert.ts`), leaderboard (`trades`).

Both bugs vanish if we stop hand-parsing and use the SDK's typed adapters. The architectural fact remains: derived metrics (uPnL, liq distance, risk tier) must be produced by **combining** the structural `traderState` with a price feed and, for margin-engine values, REST.

---

## 2. Confirmed payload shapes (docs + probe + SDK types)

`traderState` snapshot (structural only — SDK type `TraderStateSubaccountSnapshot`):
```
subaccounts[].{ subaccountIndex, sequence, collateral, positions[], orders[], splines[], triggers[] }
positions[].{ symbol, basePositionLots(signed), entryPriceUsd, virtualQuotePositionLots,
              unsettledFundingQuoteLots, conditional{TakeProfit,StopLoss}Triggers[] }
```
No `markPrice/unrealizedPnl/liquidationPrice/riskTier/effectiveCollateral`. Confirmed by probe: snapshots #1–#4 byte-identical while SOL moved 82.065→82.105; ~15s/40-slot heartbeat.

`traderState` delta (SDK type `TraderStateSubaccountDelta`) — **structured per-row**, not a blob:
```
deltas[].{ subaccountIndex, sequence, collateral,
  positions: TraderStatePositionDelta[] { symbol, change: added|updated|removed, position? },
  tradeHistory: TraderStateTradeHistoryDelta[] { market, tradeType: limit|market|liquidation,
       size, liquidity: maker|taker, price, fee, realizedPnl, signature, timestamp },
  orderHistory: [...] }
```
→ `tradeHistory` is a **typed fills source** (incl. `tradeType:"liquidation"` and `realizedPnl`). (We've only captured `snapshot`s so far — still verify a live `delta` by trading under the probe.)

Price/market channels (SDK types):
- `allMids` → `{ mids: Record<symbol,number>, slot, slotIndex }` (~5s, all markets).
- `markPrice(symbol)` → `{ symbol, markPrice, slot, slotIndex }` (true mark — what liquidations use).
- `marketStats(symbol)` → `{ symbol, stats:{ markPrice, oraclePrice, openInterest, currentFundingRate, eightHourFundingRate, annualizedFundingRate, dayVolumeUsd, ... } }` (mark **and** funding in one channel).
- `fundingRate(symbol)` → `{ symbol, funding }`.
- `fills(symbol?)` → `{ symbol, fill:{ marketSymbol, baseQty, quoteQty, price, instructionType, transactionSignature, timestampMs } }` — **market-wide, no authority/taker field** ⇒ NOT usable for per-account fills. Use `traderState` `tradeHistory` instead.
- `notifications({ authority })` → `NotificationItem` per account — **probe this**: may carry server-pushed risk/liquidation events that could replace some REST polling.

---

## 3. Use the Rise SDK WS client

`createPhoenixWsClient(config)` returns a `PhoenixWsClient` facade over **one multiplexed transport** (`wsClient`), with built-in backoff/reconnect, auto-resubscribe (`onResub`), Zod-validated + BigInt-safe payloads, a `onServerError` listener, and `close()`. Every channel is an **async-iterable adapter** taking an `AbortSignal`:

```ts
for await (const u of ws.traderState(authority, 0, signal)) { /* typed TraderStateUpdate */ }
for await (const u of ws.allMids(signal))                    { /* { mids, slot } */ }
for await (const u of ws.marketStats(symbol, signal))        { /* { symbol, stats } */ }
```

What adopting it buys us:

| Concern | Hand-rolled (old draft) | Rise SDK |
|---|---|---|
| Bug A (subscribe frame) | we must get `authority`/`traderPdaIndex` right | adapter builds it |
| Bug B (payload cast) | manual `as` cast (the bug) | typed `TraderStateUpdate`, schema-validated |
| Connections | 1 socket per wallet, **cap 500** | **1 multiplexed socket** for all channels/wallets |
| Reconnect/backoff/jitter | hand-coded per socket | built in (`backoff`, auto-resub) |
| BigInt / parsing | manual | handled |
| Extra channels | discover ourselves | `markPrice`, `marketStats`, `notifications`, typed `tradeHistory` |

The 500-connection cap and all the reconnect code in today's `ws.ts` go away. We manage **one `AbortController` per subscription** instead of one socket per wallet.

Channel selection for our features:
- **Price clock + values:** `allMids()` (one subscription, every market) drives the eval loop and price alerts. For risk-accurate liq math use **`marketStats(symbol)`** per *held* symbol (gives true `markPrice` **and** funding) — avoids a separate `fundingRate` sub.
- **Account structure + fills + liquidation events:** `traderState(authority, 0)` per owner + monitored wallet.
- **Margin-engine values (liq price / riskTier / effectiveCollateral):** REST `getTraderState` refresh (SDK WS doesn't carry them). Probe `notifications` as a possible push-based alternative for risk/liquidation.

---

## 4. Target architecture

```
            ┌───────────── createPhoenixWsClient (ONE multiplexed socket) ─────────────┐
            │  ws.allMids() ─► priceCache(mids)  ──────────────► fan-out               │
            │  ws.marketStats(heldSymbol) ─► mark/funding cache (accurate per market)  │
            │  ws.traderState(authority,0) ─► AccountSnapshotCache (structural)         │
            │        └─ delta.tradeHistory ─► fills (copy-trade + referral + liq event) │
            └──────────────────────────────────────────────────────────────────────────┘
                                      │ price tick (throttled ~1s)
                                      ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │ Eval loop: per active wallet → deriveMetrics(snapshot, prices)                  │
   │   uPnl / notional / exposure  (drawdown, pnl_target, exposure_limit, funding)   │
   │   + RestCache{ liqPriceBySymbol, riskTier, effectiveCollateral }                │
   │     (liq_distance, margin_ratio, risk-tier)  ──►  evaluators ──► alertQueue      │
   └───────────────────────────────────────────────────────────────────────────────┘
   RestRefreshLoop (token-bucketed getTraderState): refresh on account-change + slow timer
```

`allMids`/`marketStats` = clock. `traderState` = structural snapshot + account events (fills/flips/liquidations). REST = margin-engine gap. All WS over one connection.

---

## 5. File-by-file changes

### 5.1 `src/services/phoenix/client.ts` — add a shared WS client singleton ✅ DONE
```ts
import { createPhoenixWsClient, type PhoenixWsClient } from "@ellipsis-labs/rise";
let _ws: PhoenixWsClient | null = null;
export function getPhoenixWsClient(): PhoenixWsClient {
  if (!_ws) {
    _ws = createPhoenixWsClient({
      url: config.PHOENIX_WS_URL,
      backoff: { baseMs: 1000, maxMs: 30_000 },
      onServerError: (m) => logger.error({ m }, "Phoenix WS server error"),
    });
  }
  return _ws;
}
export function closePhoenixWsClient() { _ws?.close(); _ws = null; }
```

### 5.2 `src/types/index.ts` — normalized cache types (re-use SDK wire types for the rest) ✅ DONE
Import `TraderStateUpdate`, `TraderStateSubaccountSnapshot`, `TraderStatePositionDelta`, `TraderStateTradeHistoryDelta` from the SDK; we only add our **derived/cached** shapes:
```ts
export interface CachedPosition {
  symbol: string; side: "long" | "short";
  sizeTokens: number; basePositionLots: number;
  entryPrice: number; subaccountIndex: number;
  unsettledFundingUsdc: number; hasTp: boolean; hasSl: boolean;
}
export interface AccountSnapshot {
  walletAddress: string; depositedCollateralUsdc: number;
  positions: CachedPosition[]; sequenceBySub: Record<number, number>; updatedAt: number;
}
export interface RestDerived {
  riskTier: RiskTier; effectiveCollateralUsdc: number;
  liqPriceBySymbol: Record<string, number>; updatedAt: number;
}
```

### 5.3 `src/services/phoenix/price-feed.ts` — NEW (SDK-backed) ✅ DONE
Maintains latest mids and a tick fan-out; price-alerts + eval loop both consume it. No raw socket.
```ts
import { getPhoenixWsClient } from "./client.js";
const mids = new Map<string, number>();
type TickFn = (mids: Map<string, number>) => void | Promise<void>;
const subs = new Set<TickFn>();
let ac: AbortController | null = null;
export const getMid = (s: string) => mids.get(s);
export const onMids = (fn: TickFn) => (subs.add(fn), () => subs.delete(fn));

export function startPriceFeed() {
  ac = new AbortController();
  (async () => {
    for await (const u of getPhoenixWsClient().allMids(ac.signal)) {
      for (const [s, p] of Object.entries(u.mids)) mids.set(s, p);
      for (const fn of subs) Promise.resolve(fn(mids)).catch((err) => logger.error({ err }, "mids sub"));
    }
  })().catch((e) => { if ((e as Error).name !== "AbortError") logger.error({ e }, "allMids loop"); });
}
export function stopPriceFeed() { ac?.abort(); }
```
`price-alert.ts`: delete its own `allMids` socket; `onMids((m) => checkPriceAlerts(Object.fromEntries(m)))` (keep its 1s throttle + dedup).

### 5.4 `src/services/phoenix/market-stats-feed.ts` — NEW (mark + funding per held symbol) ✅ DONE
```ts
import { getPhoenixWsClient } from "./client.js";
const stats = new Map<string, { markPrice: number; annualizedFunding: number; eightHourFunding: number }>();
const acs = new Map<string, AbortController>();
export const getStats = (s: string) => stats.get(s);
export function ensureMarketStats(symbol: string) {
  if (acs.has(symbol)) return;
  const ac = new AbortController(); acs.set(symbol, ac);
  (async () => {
    for await (const u of getPhoenixWsClient().marketStats(symbol, ac.signal)) {
      stats.set(symbol, { markPrice: u.stats.markPrice, annualizedFunding: u.stats.annualizedFundingRate, eightHourFunding: u.stats.eightHourFundingRate });
    }
  })().catch((e) => { if ((e as Error).name !== "AbortError") logger.error({ e, symbol }, "marketStats loop"); });
}
export function dropMarketStats(symbol: string) { acs.get(symbol)?.abort(); acs.delete(symbol); }
```
Lifecycle: when the union of held symbols changes (from the snapshot cache), `ensureMarketStats`/`dropMarketStats`.

### 5.5 `src/workers/ws.ts` — rewrite around the SDK traderState adapter ✅ DONE
Drop: raw `WebSocket`, `ensureConnection`, reconnect/backoff/jitter, `MAX_WS_CONNECTIONS`, the `ws:positions:*` Redis prev store, and `JSON.parse(raw) as TraderStateEvent`. Keep: `ownerMap`/`watcherIndex`/`ownerUserIdCache`, the `monitor:events` pub/sub, `subscribeUser/subscribeMonitored/unsubscribe*`.

```ts
import { getPhoenixWsClient } from "../services/phoenix/client.js";
import { getMarket } from "../services/phoenix/market.js";
import type { AccountSnapshot, CachedPosition } from "../types/index.js";
import type { TraderStateUpdate } from "@ellipsis-labs/rise";

const controllers = new Map<string, AbortController>();   // wallet → subscription
const snapshots = new Map<string, AccountSnapshot>();      // wallet → structural cache
export const getSnapshot = (w: string) => snapshots.get(w);
export const getActiveWallets = () => [...snapshots.keys()];

function subscribeTrader(wallet: string) {
  if (controllers.has(wallet)) return;
  const ac = new AbortController(); controllers.set(wallet, ac);
  (async () => {
    for await (const update of getPhoenixWsClient().traderState(wallet, 0, ac.signal)) {
      await applyTraderState(wallet, update);
    }
  })().catch((e) => { if ((e as Error).name !== "AbortError") logger.error({ e, wallet }, "traderState loop"); });
}
function unsubscribeTrader(wallet: string) { controllers.get(wallet)?.abort(); controllers.delete(wallet); snapshots.delete(wallet); }
```
`subscribeUser/subscribeMonitored` now call `subscribeTrader(wallet)` (idempotent); `unsubscribe*` call `unsubscribeTrader` when no owner+watchers remain. No connection cap needed (one multiplexed socket).

`applyTraderState` — merge snapshot/delta into the cache, emit fills, refresh REST, run structural evaluators:
```ts
async function applyTraderState(wallet: string, u: TraderStateUpdate) {
  const prev = snapshots.get(wallet);
  const prevPositions = prev?.positions ?? null;

  let bySub = new Map<number, CachedPosition[]>();
  let collateralBySub = new Map<number, number>();
  if (prev) { /* seed bySub/collateralBySub from prev (delta path) */ }

  if (u.messageType === "snapshot") {
    bySub = new Map(); collateralBySub = new Map();
    for (const s of u.subaccounts) {
      bySub.set(s.subaccountIndex, await normalizeSnapshotPositions(s.positions));
      collateralBySub.set(s.subaccountIndex, Number(s.collateral) / 1e6);
    }
  } else {
    for (const d of u.deltas) {
      collateralBySub.set(d.subaccountIndex, Number(d.collateral) / 1e6);
      const list = bySub.get(d.subaccountIndex) ?? [];
      for (const pd of d.positions) applyPositionDelta(list, pd);  // added/updated/removed by symbol
      bySub.set(d.subaccountIndex, list);
    }
  }

  const next: AccountSnapshot = {
    walletAddress: wallet,
    depositedCollateralUsdc: [...collateralBySub.values()].reduce((a, b) => a + b, 0),
    positions: [...bySub.values()].flat(),
    sequenceBySub: mergeSeq(prev, u),
    updatedAt: Date.now(),
  };
  snapshots.set(wallet, next);
  syncHeldMarketStats(next);                 // ensure/drop marketStats subs for held symbols

  if (u.messageType === "delta") {
    const fills = u.deltas.flatMap((d) => d.tradeHistory ?? []);   // TraderStateTradeHistoryDelta[]
    if (fills.length) await onFills(wallet, fills);                // copy-trade + referral + liquidation events
  }
  markRestDirty(wallet);                      // liq/riskTier may have moved
  await runStructuralEvaluators(wallet, next, prevPositions);      // flip + monitor (no price needed)
}

async function normalizeSnapshotPositions(rows): Promise<CachedPosition[]> {
  const out: CachedPosition[] = [];
  for (const p of rows) {
    const lots = Number(p.basePositionLots); if (lots === 0) continue;
    const { baseLotsDecimals } = await getMarket(p.symbol);        // cached 5min
    out.push({
      symbol: p.symbol, side: lots > 0 ? "long" : "short",
      sizeTokens: Math.abs(lots) * 10 ** -baseLotsDecimals, basePositionLots: lots,
      entryPrice: Number(p.entryPriceUsd ?? 0), subaccountIndex: 0,
      unsettledFundingUsdc: Number(p.unsettledFundingQuoteLots) / 1e6,
      hasTp: (p.conditionalTakeProfitTriggers?.length ?? 0) > 0,
      hasSl: (p.conditionalStopLossTriggers?.length ?? 0) > 0,
    });
  }
  return out;
}
```
Sequence gaps: the SDK validates/auto-resubscribes; on resub it re-emits a fresh `snapshot`, so our cache self-heals (rebuild on snapshot). Verify the SDK surfaces resub as a snapshot (probe).

### 5.6 `src/workers/rest-refresh.ts` — NEW (margin-engine cache) ✅ DONE
Unchanged from prior draft: token-bucketed `getTraderState` (REST, via `position.ts`, which already computes `liquidationPrice`/`riskTier`/`effectiveCollateral`); cache per wallet; refresh on `markRestDirty` (account-event) + slow sweep (~20s). Supplies `liq_distance`, `margin_ratio`, risk-tier. (Consider replacing with the `notifications` channel if probing shows server-pushed risk events.)

### 5.7 `src/workers/eval-loop.ts` — NEW (price-driven) ✅ DONE
```ts
import { onMids } from "../services/phoenix/price-feed.js";
import { getStats } from "../services/phoenix/market-stats-feed.js";
import { getSnapshot, getActiveWallets } from "./ws.js";
import { getRestDerived } from "./rest-refresh.js";

let running = false, last = 0;
export function startEvalLoop() {
  onMids(async (mids) => {
    const now = Date.now(); if (running || now - last < 1000) return; running = true; last = now;
    try {
      for (const wallet of getActiveWallets()) {
        const snap = getSnapshot(wallet); if (!snap?.positions.length) continue;
        const derived = deriveMetrics(snap, mids);      // prefer getStats(sym).markPrice, fallback mids
        await runPriceEvaluators(wallet, snap, derived, getRestDerived(wallet));
      }
    } finally { running = false; }
  });
}
export function deriveMetrics(snap, mids) {
  const positions = snap.positions.map((p) => {
    const mark = getStats(p.symbol)?.markPrice ?? mids.get(p.symbol) ?? p.entryPrice;
    const uPnl = (p.side === "long" ? mark - p.entryPrice : p.entryPrice - mark) * p.sizeTokens + p.unsettledFundingUsdc;
    return { ...p, mark, uPnl, notional: p.sizeTokens * mark };
  });
  return { positions, totalExposure: positions.reduce((a, p) => a + p.notional, 0) };
}
```

### 5.8 Evaluators — new input contract `(wallet, snap, derived, rest)` ✅ DONE
| Evaluator | Reads | Source |
|---|---|---|
| `evaluatePositionFlip` (`tpsl_flip`) | side change | structural (snapshot diff) — `runStructuralEvaluators`, no price |
| `evaluateMonitorAlerts` (copy-trade) | open/close/flip + fills | structural diff + `tradeHistory` |
| Guardian drawdown / pnl_target / exposure_limit | uPnl / notional / exposure | `derived` |
| Guardian funding_drain | held funding × notional | `getStats(sym).annualizedFunding` × notional ÷ 365 (or 8h×3) |
| Guardian liq_distance | cached liq vs live mark | `rest.liqPriceBySymbol` + `derived.mark` |
| Guardian margin_ratio | effColl / exposure | `rest.effectiveCollateralUsdc` + `derived.totalExposure` |
| `evaluateRiskTier` | risk tier | `rest.riskTier` (or `notifications`) |

The evaluators' *output* (FormattedString messages, keyboards, `alertQueue.add`, cooldown, dedup, `isAlertEnabled`) is unchanged — only their inputs change. `liq_distance` uses the user-validated model: cached REST liq vs live mark each tick.

### 5.9 Fills, referral, liquidation events ✅ DONE
`onFills(wallet, tradeHistory[])`:
- **Copy-trade fills** (`evaluateMonitorAlerts` watchers) — was `event.fills`, now `TraderStateTradeHistoryDelta` (`market`, `size`, `price`, `liquidity`).
- **Referral accrual** (`REFERRAL_ENABLED`) — notional = `size × price` per entry.
- **Bonus: liquidation alerts** — entries with `tradeType:"liquidation"` give a precise, event-driven liquidation notification (today's risk-tier alert only *warns near* liquidation).

### 5.10 `src/main.ts` wiring ✅ DONE
```ts
startRestRefreshLoop();
startPriceFeed();        // ws.allMids
startEvalLoop();         // registers onMids
await startWsManager();  // ws.traderState per wallet (SDK) + marketStats lifecycle
```
`shutdown()`: stop loops, `closePhoenixWsClient()`.

---

## 6. Rollout order (each step shippable + testable)
0. ✅ **Add SDK WS client singleton** (`getPhoenixWsClient`) + a probe variant using `ws.traderState()` to confirm typed updates/deltas.
1. ✅ **Foundation:** rewrite `ws.ts` onto `ws.traderState()` + snapshot cache. Instantly revives `tpsl_flip` + wallet-monitor open/close/flip (pure structural). Drop 500-cap + Redis prev store.
2. ✅ **Fills:** `onFills` from delta `tradeHistory` → monitor_fill + referral + liquidation alert. (Needs a live delta capture.)
3. ✅ **Price feed:** `price-feed.ts` (SDK `allMids`); migrate `price-alert.ts` to consume it; add `eval-loop.ts`.
4. ✅ **Guardian price rules:** drawdown / pnl_target / exposure_limit via `derived`.
5. ✅ **marketStats feed + funding_drain.**
6. ✅ **REST refresh loop** → risk-tier + liq_distance + margin_ratio. (Or `notifications` if probe shows server-pushed risk events.)

---

## 7. Open decisions
1. **Mark price source:** `marketStats(symbol).markPrice` (true mark, per held symbol) vs `allMids` mid (one sub, all). Recommend marketStats for held symbols (risk-accurate), allMids as broad clock + price-alert source.
2. **`pnl_target` margin basis** (cross ambiguity): subaccount `collateral` (recommended) vs initial-margin-from-tiers. Centralize in `marginForPosition()`.
3. **Effective collateral / riskTier:** REST (authoritative, ~20s lag) vs `notifications` push vs live approximation (`deposited + ΣuPnl + funding`). Start REST; probe `notifications`.
4. **funding_drain units:** use `annualizedFundingRate ÷ 365` or `eightHourFundingRate × 3` for daily cost (replaces today's `rate × 24` assumption).
5. ✅ **Delta semantics — CONFIRMED** (live capture, 2026-05, SOL 25% partial close). `change` is `"updated"` (carries the full new `position` row) or `"closed"`; `collateral` is the full new value; `tradeHistory[]` carries the fill (`size`/`price`/`liquidity`/`tradeType`/`realizedPnl`/`signature`); `sequence` increments; a fresh `snapshot` follows the delta (idempotent). Implementation + `tests/unit/workers/trader-state-merge.test.ts` validated against the captured payload.
6. **REST rate budget:** shared `TokenBucket(2,0.5)` with leaderboard; prioritize `dirty` + near-liquidation wallets; consider a dedicated bucket.
7. ⛔ **`notifications` requires auth — DEFERRED.** Live probe returned `auth_required_notifications_subscription` (401); the channel needs a Phoenix wallet-session (`sessionManager`/`authMode`), so it can't replace the REST risk path without wiring session auth. `traderState`/`allMids`/`marketStats` are public and work unauthenticated. Keep `rest-refresh` (§5.6).

---

## 8. Testing & verification
- **Probe:** extend `ws-probe.ts` to use `getPhoenixWsClient()` adapters; capture a real `delta` + `tradeHistory` while trading; capture `notifications` for the wallet; confirm `marketStats` mark vs `allMids` mid drift.
- **Unit:** `deriveMetrics` (long/short uPnL, funding), `normalizeSnapshotPositions` (lot→token, sign→side), `applyPositionDelta` (added/updated/removed), snapshot diff → open/close/flip, `liq_distance` (cached liq + live mark).
- **Integration** (pattern of `tests/integration/guardian.test.ts`): feed synthetic snapshot+prices+rest, assert `alertQueue.add` payloads per rule; assert cooldown (5min DB) + Redis dedup still gate.
- **Manual:** on `HiYGtw…`, set `pnl_target` near current PnL → fires within ~1–5s of a tick; set `liq_distance` → fires off live mark, not the 15s heartbeat.

---

## 9. What stays unchanged
- `alertQueue` + alert worker (dedup 5s, send). Guardian DB/cooldown/kill-switch/presets/command UX. Per-alert Redis dedup + `lastTriggeredAt` cooldown (fire-step gates). Leaderboard `trades` worker. `ownerMap`/`watcherIndex`/`monitor:events` pub/sub.

---

## 10. Risks
- **SDK behavior:** delta `change` semantics ✅ confirmed; resub-emits-snapshot ✅ observed (snapshot follows delta); `notifications` ⛔ needs auth; backpressure of many `traderState` iterators on one socket still to observe at scale.
- **One multiplexed socket = one failure domain.** Built-in backoff mitigates, but a transport drop pauses every channel briefly; ensure resub rebuilds caches from fresh snapshots.
- **REST scaling** for liq/riskTier under load (mitigations §7.6).
- **Horizontal scaling:** snapshot cache + indexes are in-memory; multi-instance needs shared state (out of scope).
- **`fills` channel is market-level** (no authority) — must use `tradeHistory`; don't accidentally wire `ws.fills()` for per-account.
```
