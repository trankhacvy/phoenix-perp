# Phoenix-Perp / SuperNova Bot — Deep Research Report

## 1. What this project is

**SuperNova** (package name `supernova-bot`, also referred to as `PhoenixPerpBot` in PRDs) is a Telegram-native perpetual futures trading bot that routes orders through **Phoenix Protocol** — Ellipsis Labs' fully on-chain CLOB-based perp DEX on Solana. It targets the same niche that Trojan / BONKbot / Maestro occupy for spot trading, but for leveraged derivatives.

It pursues three business outcomes:

1. **Builder fee revenue** — every trade routes through Phoenix's "Flight" builder program at 10 bps taker (configurable `BUILDER_FEE_BPS`). The operator owns the `BUILDER_AUTHORITY_PUBKEY`.
2. **Custodial UX** — each Telegram user gets a Privy-managed embedded Solana wallet so there's no seed-phrase friction.
3. **Retention via alerts** — real-time WebSocket alerts (risk tier, TP/SL flip, price, wallet-monitor) drive daily opens.

Target launch is Q3 2026 (PRD v1.1, May 2026). PRD v1.1 explicitly drops copy-trading to v3 because Phoenix has no leaderboard API yet, and notes both the Phoenix perp product and the Flight SDK are in beta.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (ESM, `"type": "module"`, `moduleResolution: NodeNext` → all imports use `.js` even from `.ts` source) |
| Language | TypeScript 5.7 |
| Package manager | pnpm 10.15 |
| Bot framework | grammY 1.31 + `@grammyjs/parse-mode` (FormattedString) + `@grammyjs/runner` (sequentialize) + `@grammyjs/auto-retry` |
| HTTP server | Fastify 5 (only used in production webhook mode) |
| Phoenix SDK | `@ellipsis-labs/rise@^0.4.9` ("Rise" is the actual Flight SDK npm name — CLAUDE.md still claims this isn't installed; it IS installed and used) |
| Solana | `@solana/kit`, `@solana/signers`, `@solana/web3.js`, `@solana-program/{compute-budget,system,token}`, `bs58` |
| Wallet custody | `@privy-io/node` + `@privy-io/node/solana-kit` — app-owned wallets controlled by an authorization key |
| DB | PostgreSQL via `drizzle-orm` + `postgres-js` |
| Cache / locks / queues | Redis via `ioredis` + BullMQ |
| Image gen (PnL & wallet cards) | `satori` (JSX → SVG) → `sharp` → PNG, with Space Grotesk font, JPG backgrounds for win/lost |
| QR | `qrcode` |
| Technical indicators | `technicalindicators` (RSI/MACD/BB/ATR) |
| Validation | Zod (env config) |
| Logger | pino + pino-pretty |
| Lint/format | Biome 1.9 |
| Tests | Vitest 2.1 (unit + integration configs) |

Notable absence: no Anchor / no Solana program code in this repo — it's a pure off-chain client. The Phoenix on-chain program (`EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih`) is referenced only for `getProgramAccounts` discovery in `services/leaderboard.ts`.

---

## 3. Process & runtime topology

Single Node process spawned from `src/main.ts`. There is **no worker isolation across processes** — the bot, WS manager, alert worker, and leaderboard scanner all run in the same event loop and share:

- one `ioredis` client (`src/lib/redis.ts`)
- one Postgres pool (`src/db/index.ts`)
- one Phoenix read client + one trading client (`src/services/phoenix/client.ts`)
- one Helius RPC connection (instantiated per file in a couple of places — `wallet.ts`, `leaderboard.ts`, `trade.ts`)

| Component | File | Role |
|---|---|---|
| grammY bot | `src/bot/index.ts` | webhook + middleware stack + command/callback dispatch |
| Fastify webhook server | `src/server/index.ts` | only started when `NODE_ENV=production` AND `WEBHOOK_URL` set; otherwise long-polling |
| WS manager (user) | `src/workers/ws.ts` | per-user `traderState` subscriptions + global `allMids` for price alerts |
| Alert worker (BullMQ) | `src/jobs/processors/alert.ts` | consumes `alerts` queue, dedups via Redis NX, sends Telegram messages |
| Leaderboard scanner | `src/workers/leaderboard.ts` | production-only; GPA discovery + per-market `trades` WS + REST hydration loop |
| Action-log retention | `src/main.ts` `startActionLogRetention` | DELETEs `action_logs` older than 30 days every 24h |

Shutdown is wired to `SIGTERM`/`SIGINT` → `bot.stop()` → server close → stop all workers. `uncaughtException` triggers full shutdown; `unhandledRejection` just logs.

Webhook URL is derived deterministically: `sha256(TELEGRAM_BOT_TOKEN).slice(0, 32)` mounted at `/webhook/<slug>`, with `WEBHOOK_SECRET` validated against the `x-telegram-bot-api-secret-token` header.

---

## 4. Bot request pipeline

```
Telegram update
  → grammY (webhook or long-poll)
  → sequentialize(getSessionKey=ctx.from.id)   # serialize per-user updates
  → rateLimitMiddleware                         # 20 req/min global
  → authMiddleware                              # loads ctx.user from DB
  → actionLogMiddleware                         # wraps next(), writes action_logs
  → [for /long, /short] orderRateLimitMiddleware # 5 orders/min
  → command handler / callback handler
  → grammy's bot.on("message:text") free-text dispatcher
    (read pending:<telegramId> from Redis → route to deposit, withdraw, trade size/lev, addmargin, editsl/edittp, monitor_add, settings_* flows)
  → bot.on("callback_query:data") catch-all logs "unmatched callback query"
  → bot.catch handles GrammyError / HttpError → renderBotError
```

`ctx.user` is `undefined` for first-time users. `/start` is the only handler that handles that case — every other command short-circuits with "Please run /start first." The `authMiddleware` has a dev-only branch: when `TEST_KEYPAIR` is set AND `NODE_ENV=development`, missing users are upserted with `phoenixActivated: true` so a single signer can self-onboard.

---

## 5. Data layer

### Postgres tables (Drizzle, `src/db/schema/`)

| Table | Purpose | Notes |
|---|---|---|
| `users` | telegram_id PK (string), Privy IDs, walletAddress, `phoenixActivated`, `referralCode`, `referredBy` | `id === telegramId` today, but `getOwnerUserId` is the canonical lookup so the PK could change |
| `alert_subscriptions` | pgEnum `alert_type`: at_risk/cancellable/liquidatable/fill/tpsl_flip/price/funding_flip/large_funding (fill+funding* deprecated, kept for back-compat) | `symbol=null` means "all markets"; `triggerPrice` only for `price` type (sign encodes above/below — negative = below) |
| `user_settings` | slippage bps, default leverage, confirmTrades, confirmClose, feeMode enum eco/normal/turbo/custom, customFeeSol, autoTpPct, autoSlPct | pgEnum `fee_mode` |
| `wallet_monitors` | watched_wallet, label, alert flags, enabled; UNIQUE(user_id, watched_wallet) | enforces "follow" idempotency |
| `action_logs` | command, args(jsonb redacted), outcome, errorCode, errorCategory, durationMs, txSignature | 30-day retention via cron in main.ts |
| `leaderboard_snapshots` | walletAddress UNIQUE, collateral/effective/uPnL/portfolioValue, riskTier, positionCount, totalVolume, realizedPnl, win/loss, discoveredVia (gpa\|ws_trades), `lastHydratedAt`, `metadata` (jsonb WalletMetadata) | 3 indexes on portfolio_value, realized_pnl, updated_at |
| `referrals` | tier enum t1/t2, accruedUsdc, claimedUsdc | bot-native — independent of Phoenix's $10K-volume native referral |
| `trades` | full insert per open/close (margin/leverage/notional/baseUnits/markPrice/fee/closeFraction/txSignature) | 3 indexes (user+ts, symbol+ts, ts) |

### Redis usage (single shared client)

- `ratelimit:{telegramId}` — 60s window, INCR+EXPIRE NX, 20/min cap
- `ratelimit:orders:{telegramId}` — same pattern, 5/min cap
- `ratelimit:wallet_create:global` — 10 new signups per 60s globally (protects Privy)
- `pending:{telegramId}` — multi-step flow state, 600s TTL (`src/bot/lib/pending.ts`). Values follow `action:arg1:arg2:…` convention parsed in `bot/index.ts:on("message:text")`
- `idem:{userId}:{callbackId}` — 120s idempotency claim per callback button press
- `trade:lock:{userId}` — 150s exclusive trade lock (> 120s tx poll timeout)
- `wd:lock:int:{userId}` / `wd:lock:ext:{userId}` — 150s withdrawal locks
- `wd:ext:{telegramId}` — pending external-withdrawal confirm payload (atomic `GETDEL` in `consumeExtConfirm` prevents double-submit)
- `ws:positions:{wallet}` — last-known positions JSON for diff detection (TTL 3600s)
- `ws:dedup:{telegramId}:risk:{type}` — 300s
- `ws:dedup:{telegramId}:tpsl_flip:{symbol}` — 60s
- `alert:dedup:{telegramId}:{type}:{symbol}` — 5s window inside the BullMQ consumer
- `alert:price:{userId}:{symbol}:{trigger}` — 3600s once-fired marker
- `lb:known:{wallet}` — 3600s "already seen via WS trades" marker for leaderboard discovery
- Pub/Sub channel `monitor:events` — bot adds/removes wallet monitors via `redis.publish`; WS manager has a separate subscriber Redis instance listening and calling `subscribeMonitored`/`unsubscribeMonitored`

### BullMQ

Single queue: `alerts` (`src/jobs/queues.ts`). Job opts: 3 attempts, exponential backoff @1s, keep 100 completed / 500 failed. Worker concurrency 10. Producers are the WS manager and (in theory) other code paths. The worker honors `BotError.retryable` — non-retryable Telegram failures are dropped rather than re-queued.

---

## 6. Wallet & identity (Privy)

`src/services/wallet.ts` — `createEmbeddedWallet(telegramUserId)`:

1. Create Privy user linked to Telegram via `linked_accounts: [{ type: "telegram", telegram_user_id }]`.
2. Create app-owned Solana wallet — `owner: { public_key: getAppPublicKey() }`, where `getAppPublicKey()` derives the SPKI/DER/base64 form of the public key from `PRIVY_AUTHORIZATION_PRIVATE_KEY` (PKCS8 → public key extraction).
3. Persist `privyUserId`, `privyWalletId`, `walletAddress` in `users`.

Signing flow:
- Production: `getPrivyKitSigner(walletAddress)` resolves `walletId` from DB, builds an `AuthorizationContext` with the authorization private key, returns a `SolanaKitSigner` from `@privy-io/node/solana-kit`.
- Dev with `TEST_KEYPAIR`: `getKitSigner` returns a singleton `KeyPairSigner` decoded from a base58 keypair. Mismatch between requested wallet address and the test signer throws — important guardrail.

`exportkey` command is gated behind `NODE_ENV=development && TEST_KEYPAIR`; not registered in production.

---

## 7. Phoenix integration

### Client

`src/services/phoenix/client.ts` — two singletons of `createPhoenixClient`:

- `_readClient` — public reads (markets, orderbook, traderState, candles, trades, funding)
- `_tradingClient` — same options + Flight `builderAuthority` if `BUILDER_AUTHORITY_PUBKEY` looks like a real base58 pubkey (length ≥ 43; stubs like `1111…1` are treated as "no builder")

Both share `apiUrl` (`PHOENIX_API_URL`), `rpcUrl` (Helius), and `exchangeMetadata.stream: false` (REST instead of WS for metadata).

### Markets

`src/services/phoenix/market.ts`:
- `getExchangeConfig` cached 5 min
- `getMarketSnapshot(symbol)` cached 30 s, parallel-fetches market+orderbook+latest funding rate, derives `markPrice = orderbook.mid`, `leverageTiers` with `maxNotionalUsdc = maxSizeBaseLots * 10^-baseLotsDecimals * markPrice`, and `isIsolatedOnly` (falls back to a hardcoded set `{GOLD, SILVER, SKR, WTIOIL}` if cache is cold)
- `getMarketListItems` parallelizes per-symbol orderbook+funding fetches with `Promise.allSettled`

### Trade execution

`src/services/phoenix/trade.ts` is the heart of order routing. Three layers:

1. **Order packet construction** via the Rise SDK (`client.ixs.orderPackets.buildMarketOrderPacket`, `buildLimitOrderPacket`, `client.ixs.placeMarketOrder`, `client.ixs.buildPlaceLimitOrder`, `client.ixs.buildPlaceStopLoss`, `client.ixs.buildCancelStopLoss`, `buildDepositIxs`, `buildWithdrawIxs`).

2. **Transaction assembly** with `@solana/kit`:
   - `pipe(createTransactionMessage({version: 0}), setFeePayer, setLifetimeUsingBlockhash, appendInstructions)`
   - Prepended: `getSetComputeUnitPriceInstruction({microLamports: fee.cuPrice})`, `getSetComputeUnitLimitInstruction({units: 250_000})`
   - Appended: `getTransferSolInstruction` to a random Jito tip account (10 hardcoded `JITO_TIP_ACCOUNTS`)
   - Blockhash cached 10 s; invalidated after each send
   - Single-instruction path = `sendInstruction`, multi-instruction path = `dispatchInstructions` (used for deposit/withdraw which return multiple ixs, and for USDC transfer = create-ATA + transferChecked)

3. **Submission** via Helius Sender (`https://sender.helius-rpc.com/fast?api-key=...`) with `skipPreflight: true, maxRetries: 0`, then `pollConfirmation` (60×2 s) tracks the signature until confirmed or block height exceeded.

**Fee config / priority fees**:

```
FEE_PRESETS = { eco: 600k tip + 100k cuPrice,
                normal: 1.5M tip + 200k cuPrice,
                turbo: 7.5M tip + 1M cuPrice }
```

`getFeeConfig("custom", customSol)` derives both from `customSol` SOL. Settings allow either preset or custom per user.

**TP/SL gotcha** (`setTpSl`): there's an explicit TODO — `buildPlaceStopLoss` doesn't accept a size, so every ladder rung becomes a full-position close. The right fix is to switch to `buildPlacePositionConditionalOrder` (sizeBaseLots/sizePercent). Today, multiple `tpLevels`/`slLevels` are sent as separate transactions in a loop (`for (const ix of ixs) await dispatchInstruction(ix, …)`) — not batched, which is inconsistent with deposit/withdraw which DO batch.

**Close position**: Reads `getTraderStateSnapshot`, finds raw `basePositionLots`, builds an `ImmediateOrCancelOrderPacket` with `OrderFlags.ReduceOnly` and a fraction-rounded `closeLots`. Self-trade behavior = `Abort`.

**USDC transfer (external withdraw step 2)**: `transferUsdc(from, to, amountNative)` uses `findAssociatedTokenPda` + `getCreateAssociatedTokenIdempotentInstruction` + `getTransferCheckedInstruction`. Standard USDC mint `EPjFWdd5…`.

### Trader state aggregation

`src/services/phoenix/position.ts:getTraderState` flattens positions across ALL subaccounts (cross + isolated), but pulls header fields (collateral, risk tier) from the cross subaccount (index 0). Side detection: `vq <= 0` ⇒ long, where `vq = virtualQuotePosition.value`. uPnL and unsettled funding are summed across subaccounts.

`computeWalletAnalytics` computes per-market and aggregate stats from raw fills. A "close" fill is detected by `realizedPnl !== 0`, and the position-action label is inverted (`side === "short" ⇒ closed a LONG`). Maker fills are detected by `instructionType === "UncrossCrank"`.

### Activation

`/activate <code>` posts to `${PHOENIX_API_URL}/v1/invite/activate` first; on non-5xx failure falls back to `/v1/invite/activate-with-referral`. On success, sets `users.phoenixActivated = true`.

---

## 8. WebSocket layer (`src/workers/ws.ts`)

Two distinct WS uses:

### A. Per-wallet `traderState` subscriptions
- One WS per watched wallet, capped at `MAX_WS_CONNECTIONS = 500`
- `connections: Map<wallet, WebSocket>` — single source of truth
- `watcherIndex: Map<wallet, Set<telegramId>>` — fan-out for monitored wallets
- `ownerMap: Map<wallet, telegramId>` — only set for bot users' own wallets
- `ownerUserIdCache: Map<wallet, userId>` — bounded at 5000, FIFO-ish eviction (`keys().next().value`)
- Reconnect: exponential backoff `min(5000*2^failures, 60000) + 50% jitter`, max 3 failures before sending a `ws_error` alert to the owner
- On message, dispatch to:
  - `handleOwnAccountEvent` — risk-tier alert (300s dedup), tp/sl flip detection (60s dedup), referral fee accrual (gated by `REFERRAL_ENABLED`)
  - `handleMonitoredWalletEvent` — diffs prev positions to detect opens/flips/closes; first event after a subscribe is silenced (no false "opened" alerts for pre-existing positions). Fan-outs to ALL watchers except the owner.

Subscribe payload: `{type: "subscribe", subscription: {channel: "traderState", wallet}}`.

### B. Global `allMids` for price alerts
- Single WS, single throttle (`PRICE_ALERT_THROTTLE_MS = 1000`)
- Loads enabled price-alert subs from DB, cached 30 s, checks each against incoming mid prices
- `triggerPrice > 0` means "above"; `< 0` means "below" (sign-encoded direction)
- Once fired, `alert:price:{userId}:{symbol}:{trigger}` keyed for 3600 s

### Cross-process coordination

Wallet-monitor add/remove flows from the bot publish to Redis pub/sub `monitor:events`; the WS worker has a **separate** `ioredis` instance (not the shared one — pub/sub needs its own connection) subscribed and reacts by calling `subscribeMonitored`/`unsubscribeMonitored`. This works today because everything is in one process, but it's deliberately designed so the WS manager could be split out.

---

## 9. Leaderboard subsystem (`src/services/leaderboard.ts` + `src/workers/leaderboard.ts`)

Production-only (`if (config.NODE_ENV === "production")` gate in main.ts).

Discovery sources:

1. **GPA scan** — `connection.getProgramAccounts(PHOENIX_PROGRAM_ID, filters: [{memcmp: TRADER_DISCRIMINANT}], dataSlice: {offset: 8, length: 148})` decodes trader accounts from raw bytes:
   - `lastUpdateSlot` at offset 8 (u64 LE)
   - `authority` pubkey at offsets 48–80
   - `quoteLotCollateral` at offset 80 (i64 LE)
   - `numMarkets` at offset 144 (u16 LE)
   
   Per authority, accumulates across PDA indices. Filters to "active" (quoteLotCollateral > 0 || numMarkets > 0) before upsert.

2. **Bot users** — every `phoenixActivated` user is hydrated eagerly on startup.

3. **WS trades stream** — one `trades` WS per market subscription; new takers are upserted with `discoveredVia: "ws_trades"`, deduped via `lb:known:{wallet}` for 1 h.

Hydration uses `getTraderState` + `fetchAllTradeHistory(wallet, 200)` + `computeWalletAnalytics`. Retry policy explicitly does NOT retry on 429 (only on transient network errors). After 10 cumulative 429s, the whole queue is dropped to avoid hammering.

Backfill cycles:
- Every 30 min — `backfillStaleTraders(false)` re-hydrates state for wallets where `lastHydratedAt > 30 min ago`, batches of 50, concurrency 2
- Every 2 h — same plus history backfill, plus another GPA re-discovery

`syncWalletTags()` reads `data/wallet-tags.json` (if present) and upserts `metadata: {name, twitter, avatar, tags}` per wallet, used by `/leaderboard` for display names.

Leaderboard endpoint (`getLeaderboard`) supports three sorts (`total_volume`, `win_rate`, `realized_pnl`) with paginated SQL ordering using `COALESCE(... , 0)` to handle nulls.

---

## 10. Bot UX & flows

### Commands registered (`src/bot/commands/`)

`start, help, activate, deposit, withdraw, markets, long, short, positions, history, alerts, settings, referral, share, funding, portfolio, export (dev), claim, pricealert (/alert), monitor, wallet, leaderboard, log (admin), status (dev)`.

### Trade flow (size-first, redesigned per plan.md)

```
/long [symbol [leverage size]]
  no args   → sendSymbolPicker
  1 arg     → sendSizeStep(symbol)        # USD risk picker
  3 args    → sendTradeConfirm directly   # one-shot CLI form
  
sendSymbolPicker → callback trade:{side}:{symbol}
sendSizeStep   → buttons trade_size:… or trade_size_custom:… (pending state)
sendLevStep    → buttons trade_lev:…   or trade_lev_custom:…   (pending state)
sendTradeConfirm → confirm:{side}:{symbol}:{lev}:{size}:{anchorPrice}
  on confirm:
    checkOrderRateLimit + claimIdempotencyKey
    preflightOpen (re-validates with skipCache when anchorPrice set)
      → PRICE_DRIFT? show refresh button (trade_refresh:…)
    acquire trade:lock:{userId} (Redis NX 150s)
    edit "⏳ Submitting…"
    fire async IIFE:
      marginToTokens (snap, marginUsdc, lev) → string
      trackAction wraps placeMarketOrder
      recordTrade async (fire-and-forget)
      subscribeUser (ensure WS subscription)
      if settings.autoTpPct || autoSlPct → setTpSl (best-effort, non-fatal)
      edit final success message with Solscan link
    finally release lock
```

`anchorPrice` is encoded via `entry.toPrecision(12)` (was `toFixed(8)` per CLAUDE.md known-bug note — fixed). Decimal leverage is accepted (`2.5x`). Idempotency uses the callback query id.

### Withdraw flow (`/withdraw`)

Adaptive picker — auto-skips steps when only one source has funds:

- Trading + wallet: source picker → dest picker (for trading) → amount picker → confirm
- Wallet only: → amount picker (always external) → addr step → confirm
- Trading only: skip source picker

External withdrawal is a 2-tx flow with explicit partial-failure recovery: if step 2 fails, the confirm state is re-queued with `source: "wallet"` so the user can retry from the bot wallet without re-debiting the Phoenix account.

State machinery uses `wd:ext:{telegramId}` with `redis.getdel` for atomic consume-on-confirm, plus `wd:lock:int|ext:{userId}` 150s locks.

### Position management (`/positions`)

List → deep-link to detail (via `t.me/<bot>?start=pos_SYMBOL_SIDE`). Detail view shows uPnL, mark/entry/liq, TP/SL, funding accrued. Actions: Close 25/50/100, Add Margin, Set SL/TP, Refresh.

Close flow respects `settings.confirmClose` toggle (when false, skips the confirm screen and executes immediately). On close, a Satori PnL card is generated and sent as a photo.

### Wallet lookup (`/wallet <addr>`)

Aggregates traderState + full trade history + leaderboard snapshot metadata. For non-own wallets, shows live positions with **Copy/Counter** deep links that launch the trade flow on the lookup user's account. Follow/Unfollow toggles wallet monitoring inline.

### Alerts UI (`/alerts`)

Four toggleable types (at_risk, cancellable, liquidatable, tpsl_flip). Persist as rows in `alert_subscriptions` with `symbol=null`. The WS worker checks via `isAlertEnabled(userId, type)` with a 30 s in-memory cache.

Price alerts (`/alert SYM PRICE` or via market detail) are stored as separate rows with `type=price, symbol, triggerPrice` (signed for direction). Max 20 active per user.

Wallet monitors (`/monitor [addr]`) — max 10 per user, dedup via UNIQUE(user_id, watched_wallet); soft-delete by toggling `enabled=false`.

### Message rendering

Per CLAUDE.md, everything uses `@grammyjs/parse-mode` `fmt` tagged templates and passes `{ entities }` rather than `parse_mode: "HTML"`. Exception: `src/jobs/processors/alert.ts` still uses `parse_mode: "HTML"` for queued alerts — those messages are HTML-escaped via `esc()` in `ws.ts` and rendered with HTML. This is the one remaining HTML codepath; the rest of the bot is `fmt`-based.

### Image generation (`src/services/image.ts`)

Satori-based, 1200×630 px. Two cards:
- `generatePnlCard` — symbol, side badge, ROI%, realized PnL, entry/exit/size/duration footer
- `generateWalletCard` — short address, total PnL, win rate, best/worst trade, fills/volume footer

Backgrounds are JPG files in `assets/` (`win.jpg`/`lost.jpg`) base64-inlined and overlaid with a left-to-right opaque-to-transparent gradient. Fonts (`SpaceGrotesk-Regular.ttf`, `SpaceGrotesk-Bold.ttf`) are read from `assets/fonts/` and cached as `ArrayBuffer`.

---

## 11. Error handling

`src/bot/lib/errors.ts` defines a `BotError` class with:
- `category` ∈ {validation, auth, config, api, network, ratelimit, tx_failed, io, gate, internal}
- `code` ∈ a fixed enum (`PRICE_DRIFT`, `INSUFFICIENT_MARGIN`, `BLOCKHASH_EXPIRED`, etc.)
- `userMessage`, `hint`, `retryable`, `meta`

`toBotError` translates raw errors via a regex pattern list (insufficient SOL / margin, isolated-only, no position, blockhash expired, rate limit, network 50x/ECONNRESET, etc.). Unmatched errors become `internal/UNKNOWN`.

`renderBotError` formats a consistent block (header + userMessage + hint + retryable suffix) and optionally `editMessageText` to replace a loading state.

The action-log middleware uses `toBotError` to record `errorCode`/`errorCategory` per call. `trackAction` is a wrapper that auto-logs success/failure around any promise; it's used by trade execution so even SDK-raised errors get categorized.

---

## 12. Tests

Unit (`tests/unit/`):
- `bot/trade-flow.test.ts` — mock-heavy, exercises leverage parsing + market snapshot mocks
- `lib/errors.test.ts`, `lib/fmt.test.ts`
- `services/market.test.ts`, `lots.test.ts`, `referral.test.ts`, `preflight.test.ts`, `image.test.ts`, `action-log.test.ts`

Integration (`tests/integration/`):
- `referral.test.ts`, `alerts.test.ts` — separate vitest config (`vitest.integration.config.ts`)

CI in `.github/workflows/ci.yml`.

---

## 13. Database migrations

Drizzle migration journals in `src/db/migrations/`:
- `0000_wallet_monitors.sql` through `0008_dapper_mathemanic.sql` (note: there are two `0005_*` and two `0006_*` files — the `_journal.json` should be inspected to verify which are canonical; this is a smell)
- Generated via `pnpm db:generate`, applied via `pnpm db:migrate`

---

## 14. Notable design decisions & subtleties

1. **One Redis client, two roles**: the shared `ioredis` is used both for cache/locks and as the BullMQ connection. The WS pub/sub subscriber for `monitor:events` is a **separate** Redis instance because `ioredis` connections in subscriber mode can't issue other commands.

2. **Sequentialized updates**: `bot.use(sequentialize(getSessionKey))` ensures per-user updates are processed in order — critical because the size-then-leverage flow uses Redis-backed pending state that would race otherwise.

3. **Idempotency by callback ID**: `claimIdempotencyKey(userId, callbackQueryId)` claims a 120 s lock per button press. Combined with `trade:lock:{userId}` (150 s) this prevents duplicate trade submission even on rapid double-taps or webhook retries.

4. **Pending state encoding**: free-text messages route through `bot/index.ts:on("message:text")` which parses `pending:<telegramId>` from Redis. Keys are `action:arg1:arg2:…` strings (e.g. `trade_lev_input:long:SOL:100`). This is essentially a manual finite-state machine in Redis — no grammY conversations plugin.

5. **Helius Sender, not stock RPC**: trades are submitted via Helius's premium "Sender" endpoint (`/fast`) with `skipPreflight + maxRetries=0` plus a Jito tip transfer; confirmation is polled separately. Standard practice for landing trades under congestion.

6. **Activation gate everywhere**: `requireActivation(ctx)` is called in commands that touch Phoenix, AND `preflightOpen` re-checks `user.phoenixActivated` — defense in depth.

7. **GPA-based discovery instead of an indexer**: the leaderboard scrapes Solana state via `getProgramAccounts` with a data slice that includes just enough to identify the authority + collateral + numMarkets. This avoids reliance on Phoenix exposing a leaderboard API.

8. **Builder fee economics**: `BUILDER_FEE_BPS = 10` (10 bps default, configurable 1–50). The `BUILDER_AUTHORITY_PUBKEY` is set on the Rise client; trades automatically route fees to it. Referrals (when `REFERRAL_ENABLED`) accrue T1=20% / T2=10% of the builder fee — paid out **operator-funded**, not via Phoenix's native referral program (which has a $10K volume threshold).

9. **Auto-TP/SL on open** — when a user has `settings.autoTpPct`/`autoSlPct`, the trade execution path calls `setTpSl` immediately after the order confirms, with `tpMode: "limit"` and `slMode: "market"`. Failure here is non-fatal — surfaced as a warning in the success message.

10. **PRD-said vs reality** — CLAUDE.md still says "The Rise SDK is not yet installed — `client.ts` contains stubs that throw." That's stale. `@ellipsis-labs/rise@^0.4.9` IS installed and `client.ts` returns real `PhoenixClient` instances. The "Phoenix USDC vs standard USDC" notes about Ember proxy contracts no longer match the current `client.ixs.buildDepositIxs` / `buildWithdrawIxs` path that the Rise SDK now provides directly.

11. **Markets that need isolated subaccounts** (`GOLD, SILVER, SKR, WTIOIL`) are blocked at multiple layers: `sendSizeStep` short-circuits with a "not available yet" message; `preflightOpen` throws `ISOLATED_ONLY_MARKET`; the markets list shows `[ISO]` tags and hides the Long/Short buttons in `/market <SYM>` detail.

12. **Action log retention** is implemented as a `setInterval(run, 24h)` in `main.ts` rather than a proper cron / pg_cron job. Survives only as long as the process does.

13. **Trade record write is fire-and-forget** (`recordTrade` doesn't await; just `.then().catch(log)`) — analytics, not source-of-truth. The Phoenix trade history API is authoritative for trades.

14. **Settings have a "skip confirm" footgun** — toggling `confirmTrades` or `confirmClose` to false triggers an explicit warning message, then trades/closes execute immediately on button-tap.

---

## 15. Known issues / smells

- CLAUDE.md is out of date (claims Rise SDK is uninstalled; mentions Ember proxy contracts that aren't in current code).
- `setTpSl` ladder fractions are not honored — every rung is full-close (explicit TODO in the code).
- `setTpSl` doesn't batch its instructions into a single tx, unlike `dispatchInstructions` for deposit/withdraw. Each level is a separate tx with its own tip.
- Two pairs of duplicate migration filenames (`0005_*`, `0006_*`) — needs `_journal.json` inspection to confirm what's actually applied.
- `discoverTraderWallets` deserializes raw account data with hardcoded byte offsets — fragile if Phoenix changes their on-chain layout.
- Alert-worker still sends `parse_mode: "HTML"` (the only non-`fmt` codepath) and relies on a custom `esc()` HTML escaper — drift risk vs the rest of the bot.
- Several files instantiate their own `Connection`/`createSolanaRpc` rather than sharing a pool (`wallet.ts`, `leaderboard.ts`, `trade.ts`).
- `getOwnerUserId` cache uses `keys().next().value` for eviction — that's the OLDEST insertion in Maps but it's an unusual pattern; a proper LRU would be safer at scale.
- `bot.api.sendMessage` errors in the alert worker drop non-retryable failures silently except for a log line — there's no DLQ.

---

## 16. Repository quick-map

```
/
├── src/
│   ├── main.ts                  # process bootstrap
│   ├── config/index.ts          # Zod env schema
│   ├── server/                  # Fastify webhook + /health
│   ├── bot/
│   │   ├── index.ts             # grammY Bot, middleware, text dispatcher
│   │   ├── middleware/          # auth, rate-limit (req + order), action-log
│   │   ├── lib/                 # errors, fmt, pending, idempotent, activation, validate, paginate
│   │   ├── keyboards/           # market/position/trade inline keyboards
│   │   └── commands/            # one file per slash command (24 commands)
│   ├── services/
│   │   ├── phoenix/             # client, market, trade, position, preflight, lots, candles
│   │   ├── wallet.ts            # Privy embedded-wallet creation, signer resolution
│   │   ├── leaderboard.ts       # GPA discovery, hydration, ranking SQL
│   │   ├── referral.ts          # T1/T2 link + fee accrual
│   │   ├── settings.ts          # user settings DAO
│   │   ├── action-log.ts        # write + trackAction wrapper, secret redaction
│   │   ├── trade-log.ts         # trades table insert (fire-and-forget)
│   │   └── image.ts             # Satori PnL/wallet cards
│   ├── workers/
│   │   ├── ws.ts                # traderState subs + allMids price alerts
│   │   └── leaderboard.ts       # cron-like scanner + per-market trades WS
│   ├── jobs/
│   │   ├── queues.ts            # BullMQ alerts queue
│   │   └── processors/alert.ts  # alerts worker
│   ├── db/
│   │   ├── index.ts             # drizzle + postgres-js
│   │   ├── schema/              # users, alerts, settings, referrals, monitors, action_logs, leaderboard, trades
│   │   └── migrations/          # 0000…0008 + meta/
│   ├── lib/                     # redis, retry, logger, constants, privy
│   └── types/index.ts           # BotContext, TraderStateEvent, PhoenixPosition, etc.
├── tests/
│   ├── unit/                    # vitest
│   └── integration/             # separate config
├── docs/                        # Phoenix protocol docs + PRDs v1.0/v1.1
├── scripts/                     # setup-db, test-onchain, test-bot, verify-gpa, register-test-user
├── data/wallet-tags.json        # leaderboard display-name metadata
├── assets/                      # fonts + PnL card backgrounds
├── biome.json, drizzle.config.ts, vitest.config.ts, vitest.integration.config.ts
├── package.json, tsconfig.json, .env.example
├── CLAUDE.md                    # project conventions (somewhat stale)
└── COMMANDS.md                  # user-facing command reference
```

79 TS files in `src/`. ESM throughout. No native bindings beyond Sharp.

---

## 17. One-paragraph summary

SuperNova is a single-process Node/TypeScript Telegram bot that proxies all interactions with Phoenix Protocol's on-chain perp DEX on Solana. Each Telegram user gets an app-owned Privy wallet whose authorization key the operator holds, so the bot signs transactions server-side without ever exposing a seed. Trades go through the `@ellipsis-labs/rise` SDK with the operator's builder authority attached so Phoenix sends builder fees back; transactions are submitted via Helius's Sender endpoint with a Jito tip. Real-time WebSocket subscriptions per wallet drive risk, TP/SL-flip, and copy-trade alerts (via BullMQ → Telegram). A separate WS to `allMids` powers user-defined price alerts. A leaderboard subsystem discovers traders via `getProgramAccounts` of the Phoenix program and keeps a ranked snapshot table refreshed from the REST API on a 30-min/2-h cadence. Postgres (Drizzle) holds users, settings, alert subs, monitors, referrals, action logs, trades, and leaderboard snapshots; Redis holds rate limits, per-user pending-flow state, idempotency claims, trade/withdraw locks, dedup keys, and the BullMQ queue. The bot UI uses inline keyboards everywhere, with size-first trade flow (USD risk → leverage → confirm), idempotency-gated execution, and rich error categorization that distinguishes retryable from terminal failures. Image generation uses Satori+Sharp for shareable PnL cards.
