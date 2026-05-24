# Phoenix Perp Bot — Deep Research Report

## Overview

A Telegram bot that lets users trade perpetual futures on the **Phoenix DEX** (Solana) without touching a wallet app. Built in TypeScript/ESM, deployed as three independent Railway services.

---

## Process Architecture

### Three independently deployed processes

| Process | Entry | Role |
|---------|-------|------|
| Bot | `src/main.ts` | grammY + Fastify webhook server |
| WS Worker | `src/workers/ws.ts` | Phoenix WebSocket subscriptions, risk/fill detection |
| Alert Worker | `src/workers/alert.ts` | BullMQ consumer, Telegram message dispatch |
| Leaderboard Worker | `src/workers/leaderboard.ts` | On-chain trader discovery + periodic hydration |

**Flow**: WS Worker detects event → adds job to BullMQ `alertQueue` → Alert Worker reads job → calls `bot.api.sendMessage`.

The bot process and alert worker both instantiate the same grammY `bot` object but use it differently: the bot process handles commands/webhooks; the alert worker uses `bot.api.sendMessage` to push notifications.

**Startup logic**: Production → webhook mode (Fastify + Telegram setWebhook). Dev → long-polling. Controlled by `NODE_ENV` and `WEBHOOK_URL` env vars.

---

## Bot Request Flow

```
Telegram → POST /webhook/<token>  (Fastify)
  → webhookCallback (grammY)
  → authMiddleware      ← loads ctx.user from DB by telegramId
  → actionLogMiddleware ← logs every action for audit trail
  → rateLimitMiddleware ← Redis INCR, 20 req/60s
  → command handler
```

`ctx.user` is `undefined` for new users; `/start` handles onboarding. All other commands guard with `if (!ctx.user)`.

**Order rate limit** (separate from general): 5 orders/60s per user. Applied via `orderRateLimitMiddleware` on `/long` and `/short` commands, and checked via `checkOrderRateLimit()` inside confirm callbacks.

---

## Multi-Step Flow State Machine

Multi-step flows (e.g., "enter a price") use Redis pending state:
- Key: `pending:<telegramId>` (TTL: 600s)
- Value: a colon-delimited action string

The free-text `bot.on("message:text")` handler in `src/bot/index.ts` dispatches based on this key. All pending states:

| Pending key format | Flow |
|---|---|
| `withdraw_amount` | Withdraw amount input |
| `deposit_amount` | Deposit amount input |
| `trade_size_input:side:SYMBOL` | Trade custom size input |
| `trade_lev_input:side:SYMBOL:AMT` | Trade custom leverage input |
| `pricealert:SYMBOL` | Price alert trigger price |
| `addmargin:SYMBOL` | Add margin amount |
| `editsl:SYMBOL:side` | Edit stop loss price |
| `edittp:SYMBOL:side` | Edit take profit price |
| `monitor_add` | Wallet monitor address input |

---

## Phoenix SDK Integration

### Client (`src/services/phoenix/client.ts`)

Two singleton clients:
- **Read client** (`getPhoenixClient()`): no builder authority; used for market data
- **Trading client** (`getTradingClient()`): includes Flight builder routing if `BUILDER_AUTHORITY_PUBKEY` is valid (≥43 chars)

Builder validity check is length-based — if the pubkey is the stub `11111...` (32 chars), Flight routing is skipped to avoid proxy panics.

### Transaction Pipeline (`src/services/phoenix/trade.ts`)

Every on-chain operation goes through:
1. Get/cache blockhash (20s TTL cache — avoids hammering RPC)
2. Build instruction(s) via Rise SDK
3. Attach signer (Privy or test keypair)
4. Wrap in a versioned transaction with:
   - `SetComputeUnitPrice` (200,000 microlamports)
   - `SetComputeUnitLimit` (250,000 CUs)
   - The instruction(s)
   - Jito tip transfer (200,000 lamports to random tip account)
5. Sign
6. Send via Helius Sender fast endpoint (skipPreflight, maxRetries=0)
7. Poll for confirmation (2s intervals, up to 60 attempts)

**Helius Sender URL** is derived from `HELIUS_RPC_URL` by extracting the `api-key` query param and constructing `https://sender.helius-rpc.com/fast?api-key=...`.

**`dispatchInstructions`** batches multiple instructions (e.g., TP + SL) into a single transaction. If only one instruction, falls back to `dispatchInstruction` for simplicity.

### Market Data (`src/services/phoenix/market.ts`)

- `getMarkets()`: 60s in-memory TTL cache
- `getMarketSnapshot()`: aggregates market config + orderbook mid + latest funding rate
- Leverage tiers: computed from `maxSizeBaseLots` × `markPrice` to get USD notionals
- `ISOLATED_ONLY_MARKETS`: `Set(["GOLD", "SILVER", "SKR", "WTIOIL"])` — these require isolated margin subaccounts and are blocked from cross-margin trading (not yet supported)

### Position Data (`src/services/phoenix/position.ts`)

`getTraderState()` fetches all subaccounts (cross + isolated) and:
- Returns `subaccount_index=0` as "cross" account for collateral figures
- Aggregates unrealizedPnl and unsettledFunding across ALL subaccounts
- Computes `markPrice` from `positionValue / positionSize`
- `side` is inferred from `virtualQuotePosition.value` (≤0 = long, >0 = short)
- Estimated leverage: `positionValue / initialMargin`

Also provides `computeWalletAnalytics()` — pure function that computes win rate, realized PnL, best/worst trade, volume per market from an array of fill history.

### Technical Analysis (`src/services/phoenix/candles.ts`)

On market detail view, fetches 60x 1H candles and computes:
- RSI(14)
- MACD (12/26/9)
- Bollinger Bands (20, 2σ)
- ATR(14)

Uses the `technicalindicators` npm package.

---

## Trade Flow (Size-First UX)

Redesigned UX — users pick size before leverage:

```
/long [SYMBOL [LEV SIZE]]
  ↓ no args
Symbol picker (paginated, 8/page, deep links per market)
  ↓ pick symbol
Size step: show balance, pick preset or enter custom
  ↓ pick size
Leverage step: show funding cost preview, pick preset or enter custom
  ↓ pick leverage
Confirm screen: shows entry~, fee, notional, liq price, funding rate
  ↓ confirm
placeMarketOrder → Solana tx → subscribeUser (WS)
  ↓ success
Show tx link + Set SL/TP buttons
```

**Preflight** (`src/services/phoenix/preflight.ts`) runs before confirm AND before execution:
- Validates activation, market exists, mark price exists
- Checks available collateral vs `marginUsdc + fee`
- Validates leverage tier constraints
- On confirm execution: checks price drift against anchor (default 50bps tolerance from `userSettings.slippageBps`)

**Anchor price** is embedded in the confirm callback data as `entry.toPrecision(12)`.

---

## Stop Loss / Take Profit

Both SL and TP use `buildPlaceStopLoss` from the Rise SDK with:
- **Direction**: `LessThan` for longs' SL / shorts' TP; `GreaterThan` for longs' TP / shorts' SL
- **OrderKind**: `StopLossOrderKind.IOC` for market orders; `Limit` for limit orders

**Known limitation**: `buildPlaceStopLoss` doesn't accept size — every order closes the full position. The ladder/fraction feature is stubbed with a `TODO` comment.

`cancelStopLoss` uses `buildCancelStopLoss` with the execution direction to distinguish SL vs TP (same call, different direction):
- `long_sl` → `LessThan`
- `long_tp` → `GreaterThan`
- `short_sl` → `GreaterThan`
- `short_tp` → `LessThan`

---

## Wallet & Identity

**Privy** creates server-side embedded Solana wallets (one per user). Wallet is "app-owned" — the server holds the authorization key, not the user.

Two signing modes:
1. **Production** (`PRIVY_AUTHORIZATION_PRIVATE_KEY`): calls `createSolanaKitSigner(privy, ...)` — Privy signs server-side
2. **Dev** (`TEST_KEYPAIR`): `initTestSigner()` loads a local keypair from base58 env var; `getKitSigner()` returns it

`getWalletUsdcBalance()` reads the standard USDC token account (`EPjFWdd5...`) via `@solana/web3.js` — NOT Phoenix USDC. Deposit flow moves this to the Phoenix PDA.

`resolvePrivyWalletId()` looks up `privyWalletId` in the DB — required for Privy API signing. If missing → error (no backfill).

---

## Alert Pipeline

### WS Worker (`src/workers/ws.ts`)

Maintains per-wallet WebSocket connections to `PHOENIX_WS_URL`. Two subscription types:
- **`traderState`**: one WS per user wallet; detects position changes, fills, risk tier changes
- **`allMids`**: single shared WS; polls all mid prices every tick for price alerts

**Own account events**:
1. Compare current positions to previous (cached in Redis with 1h TTL key `ws:positions:WALLET`)
2. Detect position side flips → `tpsl_flip` alert
3. Risk tier alerts: `atRisk`, `at_risk`, `cancellable`, `liquidatable`, `backstopLiquidatable`, `highRisk`
4. Fill alerts → also triggers `accrueReferralFee()`

**Monitored wallet events**:
- New position opened → `monitor_open`
- Position side flipped → `monitor_flip`
- Position closed → `monitor_close`
- Fill → `monitor_fill`

**Cross-process coordination**: Bot commands add/remove monitors by publishing to Redis pub/sub channel `monitor:events`. WS worker subscribes and adjusts connections.

**Reconnect logic**: 5s delay; max 3 failures before alerting user and giving up.

### Alert Worker (`src/jobs/processors/alert.ts`)

BullMQ consumer with concurrency=10.

Dedup: Redis `SET NX EX 5` on key `alert:dedup:<telegramId>:<type>:<symbol>` — prevents duplicate alerts within 5 seconds.

Non-retryable Telegram errors (blocked, invalid chat) are dropped. Retryable errors re-raise to let BullMQ retry.

**Price alert dedup** (in WS worker): `alert:price:<userId>:<symbol>:<trigger>` with 1h TTL — prevents re-triggering the same price alert until reset.

---

## Leaderboard

### Discovery (`src/services/leaderboard.ts`)

Two-phase trader discovery:
1. **GPA (getProgramAccounts)**: queries Phoenix program ID with discriminant filter + data slice at authority offset (byte 56) to extract wallet pubkeys without downloading full account data
2. **WS trades**: subscribes to per-market `trades` channel; extracts `taker` pubkey from each trade event; Redis dedup key `lb:known:<wallet>` (1h TTL)

### Hydration

`hydrateTradersBatch()` runs with configurable concurrency (default 5):
- Light hydration (every 30min): collateral, effective collateral, uPnL, portfolio value, funding, risk tier, position count
- Heavy hydration with history (every 2h): also fetches full trade history (up to 200 fills), computes win count, loss count, total volume, realized PnL

Uses `onConflictDoUpdate` — safe to re-run.

### Queries

Three sort modes: `portfolio_value`, `realized_pnl`, `total_volume`. Paginated (10/page). Three DB indexes on sort columns.

---

## Database Schema

All tables use Drizzle ORM with postgres.js.

| Table | PK | Key fields |
|---|---|---|
| `users` | `telegram_id` (string) | `wallet_address`, `privy_wallet_id`, `phoenix_activated`, `referral_code`, `referred_by` |
| `alert_subscriptions` | UUID | `user_id`, `type` (pgEnum), `symbol`, `trigger_price`, `enabled` |
| `referrals` | UUID | `referrer_id`, `referee_id`, `tier` (t1/t2), `accrued_usdc`, `claimed_usdc` |
| `user_settings` | `user_id` | `slippage_bps` (default 50), `default_leverage` (default 5) |
| `wallet_monitors` | UUID | `user_id`, `watched_wallet`, `enabled` |
| `leaderboard_snapshots` | serial | `wallet_address` (unique), all numeric fields |
| `action_logs` | UUID | `user_id`, `command`, `args`, `outcome`, `created_at` |

Alert types (pgEnum): `at_risk`, `cancellable`, `liquidatable`, `fill`, `tpsl_flip`, `price`, `funding_flip`, `large_funding`.

---

## Referral System

Two-tier, bot-native (independent of Phoenix's native referral program):

- T1: direct referee → referrer gets 20% of builder fee on every fill
- T2: referee's referee → referrer gets 10%

**Builder fee**: `BUILDER_FEE_BPS / 10_000 × notional` per fill. Default 10 bps.

`linkReferral()` runs on `/start` if a referral code was in the start payload:
1. Finds referrer by code
2. Creates T1 row
3. Looks up T2 parent (referrer's own T1 referrer) — **known bug**: query missing `eq(referrals.tier, "t1")` filter, could pick T2 row as parent

`accrueReferralFee()` is called on every fill in the WS worker.

`generateReferralCode()`: 4 random bytes → 8-char hex uppercase.

---

## Image Generation

`src/services/image.ts` generates two card types:

- **PnL card**: shown after closing a position. Win/loss background image, realized PnL + ROI% prominent, entry/exit in bottom bar
- **Wallet summary card**: shown from `/share`. Total PnL, win rate, best/worst trade

Stack: **Satori** (JSX-like object tree → SVG) → **Sharp** (SVG → PNG). Space Grotesk font (Bold + Regular TTF), loaded once and cached. Background images (`win.jpg` / `lost.jpg`) base64-encoded and cached. Canvas: 1200×630.

---

## Key Commands

| Command | Description |
|---|---|
| `/start` | Onboard new user (creates Privy wallet + DB row), or dashboard for existing |
| `/activate <code>` | Calls Phoenix `/v1/invite/activate` then `/v1/invite/activate-with-referral` as fallback |
| `/long`, `/short` | Trade entry (size-first flow) |
| `/positions` | List + detail view with close/margin/SL/TP |
| `/setsl`, `/settp` | Set/remove SL/TP for an open position |
| `/portfolio` | Account summary (collateral, PnL, positions, SOL balance) |
| `/deposit` | Two-step: receive address + QR → move wallet USDC to PDA |
| `/withdraw` | Withdraw USDC from PDA to wallet |
| `/markets`, `/market` | Market list (paginated) + detail with TA indicators |
| `/history` | Trade history with pagination and detail |
| `/referral` | Show referral link + stats |
| `/claim` | Claim accrued referral USDC rebate |
| `/alerts` | Toggle alert types on/off |
| `/pricealert` | Set price trigger alert for a symbol |
| `/monitor` | Watch external wallets for position changes |
| `/settings` | Set slippage tolerance + default leverage |
| `/share` | Generate shareable wallet analytics card |
| `/funding` | Show funding rates across all markets |
| `/leaderboard` | Top traders by portfolio value / PnL / volume |
| `/log` | Show recent action log entries (admin/debug) |
| `/wallet` | Show wallet address + SOL balance |
| `/export` | Export trade history as CSV |

---

## Known Bugs (from CLAUDE.md and code)

1. **`src/bot/commands/alerts.ts`**: alert toggle `findFirst` missing `type` filter — could match wrong alert type row
2. **`src/services/referral.ts`** L27–30: T2 chain lookup uses `eq(referrals.refereeId, referrer.id)` without `eq(referrals.tier, "t1")` — can pick a T2 row as the T2 parent, creating incorrect chains
3. **`src/services/phoenix/trade.ts`** `setTpSl()` L363: ladder fractions are silently ignored — `level.fraction` unused; every TP/SL level closes the full position
4. **`src/workers/ws.ts`** risk alert messages use raw HTML strings (`<b>`, `<code>`) and are sent with `parse_mode: "HTML"` in the alert worker — inconsistent with the project-wide rule to use `@grammyjs/parse-mode`

---

## Specifics and Quirks

### ESM / Import rules
`"type": "module"` + `moduleResolution: NodeNext` — all imports use `.js` extensions for `.ts` source files.

### Pending state TTL
600 seconds (10 min). If user takes longer, the text message will be silently dropped.

### Price anchor in callback data
Trade confirm embeds `entry.toPrecision(12)` in the callback data string. This is parsed back as `Number(anchorStr)` at execution time. If the user taps confirm after >50bps price drift, they get a `PRICE_DRIFT` error with an inline refresh button.

### Blockhash cache
20s TTL cache on latest blockhash. Multiple rapid trades can share the same blockhash. If that blockhash expires before a tx lands, a `BLOCKHASH_EXPIRED` error is thrown (retryable=true).

### Jito tip accounts
10 hardcoded tip accounts. One is randomly selected per transaction. All transactions pay 200,000 lamports (0.0002 SOL) tip.

### Action log retention
Bot process runs a daily sweep: `DELETE FROM action_logs WHERE created_at < NOW() - INTERVAL '30 days'`.

### Dev mode auth bypass
In dev (`TEST_KEYPAIR` set), `authMiddleware` auto-creates a DB user for any Telegram ID using the test keypair, with `phoenixActivated: true`. This makes all command flows work without a real Phoenix invite.

### Leaderboard GPA strategy
Instead of fetching full Trader accounts, the GPA uses `dataSlice` to extract only the 32-byte authority pubkey at offset 56 — drastically reduces bandwidth for potentially thousands of accounts.

### Monitor cross-process signaling
When a user adds/removes a monitor via the bot command, the bot publishes a `monitor:events` Redis pub/sub message. The WS worker (separate process) subscribes and reacts. This decouples the two processes without requiring direct IPC.

### `fmt` tagged template
All bot messages use `@grammyjs/parse-mode` `fmt` template and pass `{ entities: msg.entities }` (never `parse_mode`). Exception: alert worker uses raw HTML strings with `parse_mode: "HTML"` — this is a consistency issue but not a bug per se.
