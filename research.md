# SuperNova — Deep Codebase Research Report

## 1. What It Is

**SuperNova** is a Telegram bot for trading perpetual futures on Phoenix Exchange (Solana). Users interact entirely through Telegram — they receive a custodial Solana wallet, deposit USDC, and trade perps with leverage, all without leaving the chat interface.

The bot is a **single Node.js process** (no microservices, no Docker) that bundles four components: the Telegram bot, a WebSocket manager for real-time Phoenix data, a BullMQ alert worker, and a leaderboard scanner. Package name in `package.json`: `supernova-bot`.

---

## 2. Tech Stack (with versions)

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js ESM (`"type": "module"`, `.js` extensions required) | — |
| Language | TypeScript (strict, ES2022 target, NodeNext module resolution) | ^5.7.0 |
| Package manager | pnpm | 10.15.0 |
| Bot framework | grammY | ^1.31.0 |
| Message formatting | @grammyjs/parse-mode | ^2.3.0 |
| Bot extras | @grammyjs/runner, @grammyjs/auto-retry | ^2.0.3, ^2.0.2 |
| HTTP server | Fastify + @fastify/cors (webhook mode) | ^5.2.0, ^10.0.0 |
| Exchange SDK | @ellipsis-labs/rise (Phoenix perp SDK) | ^0.4.9 |
| Wallet custody | @privy-io/node + @privy-io/server-auth | ^0.19.0, ^1.20.0 |
| Solana | @solana/kit, @solana/signers, @solana/web3.js | ^6.9.0, ^6.9.0, ^1.98.0 |
| Solana programs | @solana-program/compute-budget, /system, /token | various |
| Database | PostgreSQL + Drizzle ORM | postgres ^3.4.5, drizzle-orm ^0.38.0 |
| Migrations | drizzle-kit | ^0.30.0 |
| Cache/state | ioredis | ^5.4.1 |
| Job queue | BullMQ | ^5.34.0 |
| Image generation | Satori (JSX→SVG) + Sharp (SVG→PNG) + @resvg/resvg-js | ^0.10.14, ^0.33.5, ^2.6.2 |
| Fonts | @fontsource/space-grotesk, @fontsource-variable/inter | ^5.2.10, ^5.2.8 |
| QR codes | qrcode | ^1.5.4 |
| Technical analysis | technicalindicators | ^3.1.0 |
| WebSockets | ws | ^8.20.1 |
| Logging | pino + pino-pretty | ^9.6.0, ^13.0.0 |
| Validation | zod | ^3.24.0 |
| Linting/formatting | Biome | ^1.9.4 |
| Testing | Vitest + @vitest/coverage-v8 | ^2.1.0 |
| Dev runner | tsx | ^4.19.2 |
| Encoding | bs58 | ^6.0.0 |

---

## 3. Architecture

### 3.1 Process Model

Everything starts from `src/main.ts`. Startup sequence (in order):

1. Load test signer if `TEST_KEYPAIR` is set (dev mode)
2. Start action log retention — daily cleanup of records older than 30 days
3. Start alert worker (BullMQ consumer, concurrency=10)
4. `await startWsManager()` — subscribes all users' wallets + all enabled wallet monitors + `allMids` price feed
5. `startLeaderboardScanner()` — production only (`NODE_ENV === "production"`), non-fatal if it fails
6. Register 14 public commands with Telegram + set bot description
7. In production + `WEBHOOK_URL` set: start Fastify + set webhook (URL slug = `sha256(botToken).slice(0, 32)`)
8. Otherwise: start polling mode
9. Graceful shutdown on SIGTERM/SIGINT + unhandledRejection + uncaughtException

### 3.2 Bot Request Flow

```
Telegram → POST /webhook/<sha256-slug>  (Fastify + WEBHOOK_SECRET validation)
         → grammY polling               (dev)
  → sequentialize(ctx.from.id)          (serialize per-user to prevent races)
  → authMiddleware                       (load ctx.user from DB by telegramId)
  → actionLogMiddleware                  (track command, duration, outcome, errors)
  → rateLimitMiddleware                  (Redis INCR, 20 req/60s)
  → command or callback handler
```

`ctx.user` is `undefined` for new users. Only `/start` handles onboarding. Every other command guards with `if (!ctx.user)` and replies to `/start` first.

### 3.3 Multi-Step Flows (Redis Pending State)

Commands with multiple input steps (trading, deposit, withdraw, price alerts) use Redis-backed pending state:

```
Key:   pending:<telegramId>
Value: <action>:<params>
TTL:   600 seconds (10 minutes)
```

A catch-all `bot.on("message:text")` handler in `src/bot/index.ts` reads this key and dispatches. Pending keys in use:

| Value | Flow |
|-------|------|
| `trade_size_input:long:SOL` | Waiting for custom margin amount |
| `trade_lev_input:short:BTC:500` | Waiting for custom leverage |
| `withdraw_amount:<address>` | Waiting for withdrawal amount |
| `withdraw_ext_addr:<amount>` | Waiting for external destination address |
| `deposit_amount` | Waiting for deposit amount |
| `pricealert_price:<symbol>` | Waiting for price target |
| `monitor_label:<wallet>` | Waiting for wallet label |
| `sl_price:<symbol>` | Waiting for stop-loss price |
| `tp_price:<symbol>` | Waiting for take-profit price |
| `margin_add:<symbol>` | Waiting for add-margin amount |

### 3.4 Alert Pipeline (Full Flow)

```
WS worker detects event (fill, risk tier, position change, price cross)
  ↓
alertQueue.add(jobType, { telegramId, type, symbol, message, keyboard })
  ↓
Alert worker (BullMQ, concurrency=10) picks up job
  ↓
Dedup check: redis.set(`alert:dedup:${telegramId}:${type}:${symbol}`, "1", "EX", 5, "NX")
  → NX returns null if key exists → log "deduped" + return (no retry)
  → NX returns "OK" → proceed
  ↓
bot.api.sendMessage(telegramId, message, {
  parse_mode: "HTML",
  reply_markup: { inline_keyboard: keyboard },
  link_preview_options: { is_disabled: true }
})
  ↓
On error:
  → toBotError(err) classifies: retryable vs non-retryable
  → non-retryable → log + return (drop job)
  → retryable → throw → BullMQ retries (default policy)
```

Alert types: `fill`, `risk-tier`, `tpsl-flip`, `monitor-alert`, `monitor-fill`, `price-alert`, `ws-error`.

### 3.5 WebSocket Manager (`src/workers/ws.ts`)

**In-memory data structures:**
```typescript
connections = Map<walletAddress, WebSocket>  // active WS connections
ownerMap    = Map<walletAddress, telegramId>  // bot user's own wallet
watcherIndex = Map<walletAddress, Set<telegramId>>  // all watchers incl. owner
ownerUserIdCache = Map<walletAddress, userId>  // LRU cache, max 5000 entries
```

**Startup:** At `startWsManager()`, queries all users (own wallets) + all enabled `wallet_monitors`, subscribes each. Also subscribes the `allMids` channel for price alerts.

**Per-wallet subscription:**
- One WebSocket per wallet address
- Subscribe: `{ type: "subscribe", subscription: { channel: "traderState", wallet: address } }`
- Max 500 concurrent connections; logs warn and skips beyond cap
- Reconnect: `min(5000 × 2^failures, 60_000)` + up to 50% jitter; only reconnects if still has watchers
- After 3 consecutive errors: sends `ws-error` alert to owner

**Position diff for monitors:**
- Redis key `ws:positions:<wallet>` caches last-seen positions (TTL 3600s)
- On first event (cache miss): seeds cache, skips diff — prevents false "opened" alerts
- Diff detects: new position (open), disappeared position (close), side change (flip)

**allMids price feed:**
- Single `WebSocket` (`allMidsWs`) subscribing to `{ channel: "allMids" }`
- Throttled: max 1 check per second (`PRICE_ALERT_THROTTLE_MS = 1000`) with mutex (`priceAlertCheckRunning`)
- Price alert subscriptions cached from DB with 30s TTL
- Dedup key: `alert:price:<userId>:<symbol>:<trigger>` with 3600s TTL (fires once per target)
- Trigger logic: `trigger > 0` means "above" check; `trigger < 0` means "below" (abs value)

**Redis pub/sub for dynamic subscribe/unsubscribe:**
- Channel: `MONITOR_EVENTS_CHANNEL` (constant from `src/lib/constants.ts`)
- Messages: `{ action: "subscribe" | "unsubscribe", wallet, telegramId }`
- Dedicated ioredis connection for subscriber (`monitorSub`)

### 3.6 Leaderboard Scanner (`src/workers/leaderboard.ts`)

Runs only in production. Three discovery pathways:

1. **GPA scan (every 30 min):** `getProgramAccounts` on Phoenix program, parse trader discriminant, aggregate PDAs by authority. Filter: collateral > 0 OR numMarkets > 0. Upsert into `leaderboard_snapshots` with `discovered_via='gpa'`.

2. **Bot user sync:** Query `phoenixActivated=true` users from DB → hydrate via Phoenix REST API. Computes: volume, win/loss, realized PnL, per-market breakdown, long/short ratio.

3. **WS trade discovery:** Subscribe to `{ channel: "trades", symbol }` for every market. On each trade: extract `taker`, dedup via Redis (`lb:known:<wallet>`, TTL 3600s), immediately hydrate new wallets.

**Hydration:**
- Source: Phoenix SDK `getTraderState()` + `getTraderTradesHistory()` (max 500 fills)
- Abort after 10 consecutive 429 rate-limit errors
- Wallet tags from `data/wallet-tags.json` merged into `metadata` JSONB

---

## 4. Database Schema (8 Tables)

All migrations are in `src/db/migrations/` (SQL files 0000–0007). Drizzle ORM manages types. Enum types are PostgreSQL pgEnum.

### `users`
Primary identity table. `id` = UUID PK, but `telegramId` is the actual lookup key.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID generated by application |
| `telegram_id` | text UNIQUE | Telegram user ID (string) |
| `username` | text | nullable |
| `first_name` | text | nullable |
| `privy_user_id` | text | nullable (set after Privy creates user) |
| `privy_wallet_id` | text | nullable (Privy wallet UUID) |
| `wallet_address` | text | Solana public key (NOT NULL) |
| `phoenix_activated` | boolean | trades blocked if false |
| `referral_code` | text UNIQUE | 8-char uppercase hex (4 random bytes) |
| `referred_by` | text | referral code used at signup |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### `alert_subscriptions`
Per-user alert type toggles. One row per type per user (plus optional per-symbol for price alerts).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `user_id` | text FK→users | CASCADE delete |
| `type` | pgEnum | at_risk, cancellable, liquidatable, fill, tpsl_flip, price, funding_flip, large_funding |
| `symbol` | text | null = all markets; set for price alerts |
| `trigger_price` | text | numeric string; positive = above, negative = below |
| `enabled` | boolean | |
| `created_at` | timestamp | |

### `referrals`
Two-tier chain. Created at signup when referred_by code is valid.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `referrer_id` | text FK→users | who earns the rebate |
| `referee_id` | text FK→users | who was referred |
| `tier` | pgEnum | t1 (direct), t2 (indirect) |
| `accrued_usdc` | numeric(20,6) | rebate earned but not yet claimed |
| `claimed_usdc` | numeric(20,6) | rebate already paid out |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### `user_settings`
User-configurable defaults. One row per user (upserted on change).

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | text PK FK→users | CASCADE delete |
| `slippage_bps` | integer | default 50 (0.5%), range 10–200 |
| `default_leverage` | integer | default 5, range 2–50 |
| `updated_at` | timestamp | |

### `wallet_monitors`
External wallets to monitor (max 10 per user enforced in handler).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `user_id` | text FK→users | CASCADE delete |
| `watched_wallet` | text | Solana address |
| `label` | text | optional display name |
| `alert_on_fill` | boolean | default true |
| `alert_on_position_change` | boolean | default true |
| `enabled` | boolean | default true |
| `created_at` | timestamp | |
| UNIQUE | (user_id, watched_wallet) | |

### `action_logs`
Audit trail for every bot interaction. 30-day auto-retention (swept daily at startup).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `user_id` | text FK→users | CASCADE delete |
| `command` | text | command name |
| `args` | jsonb | redacted: passwords, keys, tokens |
| `outcome` | pgEnum | success, error |
| `error_code` | text | e.g., INSUFFICIENT_MARGIN |
| `error_category` | text | e.g., validation, network |
| `duration_ms` | bigint | execution time |
| `tx_signature` | text | Solana tx sig if applicable |
| `created_at` | timestamp | |
| Indices | (user_id, created_at), (command, created_at) | |

### `leaderboard_snapshots`
Cached trader analytics. Upserted by leaderboard worker.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `wallet_address` | text UNIQUE | |
| `collateral_balance` | numeric(20,6) | |
| `effective_collateral` | numeric(20,6) | |
| `unrealized_pnl` | numeric(20,6) | |
| `portfolio_value` | numeric(20,6) | |
| `accumulated_funding` | numeric(20,6) | |
| `risk_tier` | text | |
| `position_count` | integer | |
| `total_volume` | numeric(24,6) | |
| `realized_pnl` | numeric(20,6) | |
| `win_count` | integer | |
| `loss_count` | integer | |
| `total_trades` | integer | |
| `discovered_via` | text | gpa, ws_trades, bot_user |
| `first_seen_at` | timestamp | |
| `updated_at` | timestamp | |
| `last_hydrated_at` | timestamp | staleness tracking |
| `metadata` | jsonb | { name?, twitter?, avatar?, tags? } |
| Indices | (portfolio_value), (realized_pnl), (updated_at) | |

### `trades`
Local fill records written by the bot after TX confirmation. Migration 0007.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `user_id` | text FK→users | CASCADE delete |
| `wallet_address` | text | |
| `symbol` | text | |
| `side` | text | long / short |
| `action` | text | open / close |
| `margin_usdc` | numeric(20,6) | nullable |
| `leverage` | numeric(10,2) | nullable |
| `notional_usdc` | numeric(20,6) | NOT NULL |
| `base_units` | text | size string (e.g., "0.25") |
| `mark_price` | numeric(20,6) | NOT NULL (fill price) |
| `fee_usdc` | numeric(20,6) | nullable |
| `close_fraction` | numeric(5,4) | 0–1 for partial closes |
| `tx_signature` | text | nullable |
| `status` | text | default 'confirmed' |
| `created_at` | timestamp | |
| Indices | (user_id, created_at), (symbol, created_at), (created_at) | |

---

## 5. Phoenix Integration (`src/services/phoenix/`)

The Rise SDK (`@ellipsis-labs/rise`) is **fully installed and functional**. All trade operations are real SDK calls — there are no stubs.

### 5.1 Client (`client.ts`)

Two lazy-initialized singletons:
- **Read client**: for market data queries (no Flight builder routing)
- **Trading client**: adds `flight.builderAuthority` for order routing through the builder

Builder authority validation: if `BUILDER_AUTHORITY_PUBKEY.length < 43` (stub/placeholder), Flight routing is skipped silently. Valid base58 Solana addresses are always 43–44 chars.

### 5.2 Market Data (`market.ts`)

- **Exchange config**: cached 5 minutes. All markets with leverage tiers, fees, isolated-only flag.
- **Market snapshot** (`getMarketSnapshot`): cached 30 seconds per symbol. Contains: mark price (from orderbook mid), funding rate, max leverage, taker/maker fees, leverage tier breakpoints (in USD notional), open interest, tick size, baseLotsDecimals.
- `skipCache: true` forces fresh fetch (used when anchor price is set in preflight).
- `ISOLATED_ONLY_MARKETS` constant: `Set<string>` = `{ "GOLD", "SILVER", "SKR", "WTIOIL" }`. Also checks `market.isolatedOnly` from SDK response.
- Market list hydration uses `Promise.allSettled` for graceful degradation.

### 5.3 Position State (`position.ts`)

`getTraderState(wallet)`:
- Finds cross account (subaccountIndex=0) for effective collateral and risk tier
- Aggregates positions across all subaccounts
- Computed position fields: side (from sign of virtualQuotePosition), leverage (from initial margin), TP/SL prices if orders exist

`getTraderStateSnapshot(wallet)`: raw snapshot used by `closePosition` to get current `basePositionLots`.

`computeWalletAnalytics(trades)`: from trade history array, computes total volume, realized PnL, win/loss counts, win rate, best/worst trade, per-market breakdown, long/short ratio, maker percentage.

### 5.4 Pre-Trade Validation (`preflight.ts`)

`preflightOpen(input)` — 8 sequential checks:

1. **Activation gate**: `user.phoenixActivated` must be true → `PHOENIX_NOT_ACTIVATED`
2. **Isolated-only check**: `isIsolatedOnly(symbol)` → `ISOLATED_ONLY_MARKET` (with "coming soon" hint)
3. **Input validation**: `marginUsdc > 0` and `leverage >= 1`
4. **Market snapshot**: fetches (skip cache if anchorPrice provided) → `UNKNOWN_MARKET`
5. **Live price**: `snapshot.markPrice > 0` → `MARKET_CLOSED`
6. **Collateral check**: `totalCost (margin + fee) <= effectiveCollateral` → `INSUFFICIENT_MARGIN`
7. **Leverage tier**: notional must fit within a tier, and leverage must not exceed that tier's max → `TIER_OVERFLOW`
8. **Price drift**: if anchorPrice provided, `|markPrice - anchor| / anchor > slippageBps/10000` → `PRICE_DRIFT` (retryable)

Liquidation price (approximate, ignores cross-margin existing positions):
```
long:  markPrice × (1 - 1/leverage + 0.5/maxLeverage)
short: markPrice × (1 + 1/leverage - 0.5/maxLeverage)
```
Clamped to 0 minimum.

Fee calculation: `feeUsdc = notional × (takerFee + BUILDER_FEE_BPS/10000)`

### 5.5 Trade Execution (`trade.ts`)

**Transaction construction (every trade):**
1. Build SDK instruction (market order, limit, TP/SL, close, deposit, withdraw, etc.)
2. Get signer: `TEST_KEYPAIR ? getKitSigner() : getPrivyKitSigner()`
3. Attach signer to instruction accounts: `addSignersToInstruction([signer], ix)`
4. Build v0 transaction message:
   - `SetComputeUnitPrice(200_000 microLamports/CU)`
   - `SetComputeUnitLimit(250_000 CU)`
   - The instruction(s)
   - `TransferSol` to random Jito tip account (200_000 lamports, pool of 10 addresses)
5. `signTransactionMessageWithSigners(message)` → signed tx
6. Encode to base64 → `sendViaHeliusSender()` with `skipPreflight: true, maxRetries: 0`
7. Invalidate blockhash cache (`_cachedBlockhash = null`) after send
8. `pollConfirmation(sig, blockhash)` — 2s interval, max 60 attempts, validates against block height deadline

**Blockhash caching**: 10-second TTL (`BLOCKHASH_TTL_MS = 10_000`). Cached on `getLatestBlockhash` call, invalidated after each send.

**Helius Sender URL**: extracted from `HELIUS_RPC_URL`, uses `sender.helius-rpc.com/fast?api-key=<key>`.

**Implemented operations:**
| Function | Description |
|----------|-------------|
| `placeMarketOrder` | IOC order via `client.ixs.orderPackets.buildMarketOrderPacket` + `client.ixs.placeMarketOrder` |
| `placeLimitOrder` | Limit order via `client.ixs.orderPackets.buildLimitOrderPacket` + `client.ixs.buildPlaceLimitOrder` |
| `setTpSl` | Builds `buildPlaceStopLoss` instructions. Each TP/SL level dispatched in **separate sequential transactions** (for loop). NOTE: `level.fraction` is ignored — see known limitation |
| `closePosition` | Reads `basePositionLots` from snapshot, builds IOC reduce-only order |
| `cancelStopLoss` | `client.ixs.buildCancelStopLoss` by execution direction |
| `addMargin` | Delegates to `depositCollateral` |
| `depositCollateral` | `client.ixs.buildDepositIxs` → may return multiple instructions (batched in one tx) |
| `withdrawCollateral` | `client.ixs.buildWithdrawIxs` → may return multiple instructions (batched) |
| `transferUsdc` | SPL `getTransferCheckedInstruction` with idempotent ATA creation |
| `getUsdcAtaBalanceNative` | `getTokenAccountBalance` on user's USDC ATA |

**`dispatchInstruction` vs `dispatchInstructions`:** Single-instruction operations use `dispatchInstruction`; multi-instruction operations (deposit, withdraw, transfer) use `dispatchInstructions` which batch all into one transaction.

### 5.6 Lot Conversion (`lots.ts`)

`marginToTokens(market, marginUsdc, leverage, overridePrice?)`:
- `notional = marginUsdc × leverage`
- `price = overridePrice ?? market.markPrice`
- `baseTokens = notional / price`
- `baseLots = round(baseTokens / 10^(-baseLotsDecimals))`
- Validates min 1 lot; throws if result is zero

`fractionToCloseLots(rawLots, fraction)`:
- `|rawLots| × fraction`, rounded, min 1 lot
- Returns `BigInt`

### 5.7 Candles / Technical Analysis (`candles.ts`)

Fetches OHLCV from Phoenix API for 1H timeframe. Computes via `technicalindicators`:
- RSI(14), MACD(12,26,9), Bollinger Bands(20, 2σ), ATR(14)

Displayed in `/markets <symbol>` detail view.

---

## 6. Bot Commands (Complete Inventory)

### Account Management (5 commands)
| Command | File | Description |
|---------|------|-------------|
| `/start [code]` | `start.ts` | Creates Privy wallet, stores user, shows welcome. Deep links: `long_SOL_0`, `pos_SOL_long`, `trade_<txSig>`, `wallet_<addr>`. Handles referral code at signup |
| `/activate [code]` | `activate.ts` | Activates Phoenix account via `POST /v1/invite/activate` with `BUILDER_ACCESS_CODE` |
| `/deposit` | `deposit.ts` | Two-step: (1) show wallet address + QR code, (2) move wallet USDC → Phoenix collateral |
| `/withdraw` | `withdraw.ts` | Presets 25/50/100% + custom. Two modes: bot wallet (1 tx) vs external address (2 txs: withdraw + transfer). Calculates safe-to-withdraw |
| `/settings` | `settings.ts` | Configure slippage (0.1–2.0%) and default leverage (2–50x) |

### Trading (5 commands)
| Command | File | Description |
|---------|------|-------------|
| `/long [SYM] [LEV] [SIZE]` | `long.ts` | Open long. No args → symbol picker. Partial args → guided flow. Full args → confirm directly |
| `/short [SYM] [LEV] [SIZE]` | `short.ts` | Mirror of `/long` for shorts |
| `/positions` | `positions.ts` | List open positions or view detail. Actions: close (25/50/100%), add margin, set SL, set TP, refresh |
| `/setsl` | `setsl.ts` | Set stop loss — preset % below entry or custom price |
| `/settp` | `settp.ts` | Set take profit — preset % above entry or custom price |

### Information (6 commands)
| Command | File | Description |
|---------|------|-------------|
| `/portfolio` | `portfolio.ts` | Full account: wallet USDC, trading collateral, open P&L, positions (up to 5), SOL balance, risk tier |
| `/markets [SYM]` | `markets.ts` | Paginated market browser (10/page). Detail: mark price, funding APR+direction, max leverage, fees, OI, technicals (RSI, MACD, BB, ATR) |
| `/history [addr]` | `history.ts` | Paginated trade history (5/page, last 30 fills). Shows action, size, fill price, value/PnL. Works for any wallet |
| `/funding` | `funding.ts` | Top 10 markets by funding rate magnitude, direction, daily cost per $10K |
| `/leaderboard` | `leaderboard.ts` | Top traders sorted by volume/win rate/PnL. Tap for trader detail with per-market breakdown |
| `/share <SYM>` | `share.ts` | Generate and send PnL card PNG for most recent closed trade |

### Wallet Analytics (1 command)
| Command | File | Description |
|---------|------|-------------|
| `/wallet <addr>` | `wallet.ts` | Any wallet: portfolio, open positions, all-time stats (PnL, win rate, volume, ratios), best/worst trade, per-market breakdown. Generates wallet summary card image |

### Alerts & Monitoring (3 commands)
| Command | File | Description |
|---------|------|-------------|
| `/alerts` | `alerts.ts` | Toggle fill/risk/tpsl_flip/funding_flip/large_funding alerts on/off |
| `/pricealert` | `pricealert.ts` | Set price alerts for symbols (fires once on cross, 1h dedup) |
| `/wallet-monitor` | `wallet-monitor.ts` | Monitor up to 10 wallets. Alerts on open/close/flip. Copy-trade and counter-trade buttons |

### Referral (2 commands)
| Command | File | Description |
|---------|------|-------------|
| `/referral` | `referral.ts` | Show referral link, T1/T2 counts, accrued vs claimable USDC rebate |
| `/claim` | `claim.ts` | Withdraw claimable referral rebate (minimum $1) |

### Admin/Dev (4 commands — not in public menu)
| Command | File | Description |
|---------|------|-------------|
| `/export` | `export.ts` | Dev-only: export Privy wallet private key as base58 |
| `/log [user_id]` | `log.ts` | Admin-only (`ADMIN_TELEGRAM_IDS` list): last 10 action logs for a user |
| `/status` | `status.ts` | Dev-only: preview all 9 alert message formats with live keyboards |
| `/help` | `help.ts` | Help menu organized by category |

---

## 7. Trade Flow (Detailed)

**Size-first design:** user picks risk amount before leverage.

```
Step 1: Symbol Picker (if /long with no symbol)
  → Paginated markets keyboard, 4 per row, 2 rows per page
  → Shows price + max leverage per market
  → Callback: trade:long:SOL  →  Step 2

Step 2: Size Input  (if /long SOL with no size)
  → Shows available collateral and preset buttons
  → Presets: 10%, 25%, 50%, 100% of max safe margin (computed from available collateral)
  → "Enter custom amount" button → pending key set → free-text
  → Callback: trade_size:long:SOL:<computed_amount>  →  Step 3

Step 3: Leverage Input  (if /long SOL 500 with no leverage)
  → Shows notional at each lever
  → Buttons: 2×, 5×, 10×, 25×, 50× (filtered by market maxLeverage)
  → Default leverage (from user_settings) highlighted with ★
  → Shows daily funding cost if significant
  → "Enter custom" button → pending key set → accepts decimals (e.g., "2.5")
  → Callback: trade_lev:long:SOL:500:<lev>  →  Step 4

Step 4: Confirm
  → preflightOpen() runs 8 validation checks
  → If PRICE_DRIFT: show "🔄 Refresh price" button instead of restarting
  → Display: entry price, notional, fee (% + USD), liq price (% away), daily funding, side
  → Message edited inline (not new message)
  → Keyboard: [✅ Long $X of SOL]  [🔄 Refresh price]
              [← Resize]           [✕ Cancel]
  → Callback data embeds anchor price: confirm:long:SOL:10:500:87000

Step 5: Execute (fire-and-forget IIFE)
  → claimIdempotencyKey(userId, callbackQueryId) — Redis NX, 120s TTL
  → checkOrderRateLimit() — 5 orders/60s
  → Edit message to "⏳ Submitting order to Solana…"
  → marginToTokens(market, margin, leverage) → baseUnits
  → placeMarketOrder({ symbol, side, baseUnits, walletAddress })
    → sendViaHeliusSender → pollConfirmation
  → recordTrade() to DB (fire-and-forget, non-blocking)
  → subscribeUser() for WS alerts
  → Edit message: success summary with entry, size, fee, liq price, Solscan link
  → Offer [Set Stop Loss] [Set Take Profit] buttons
  → On failure: renderBotError + retry/back buttons
```

**One-liner shortcut**: `/long BTC 10x 500` skips to confirm directly.

---

## 8. Wallet & Identity

### Privy Integration (`src/services/wallet.ts`)

- Wallet creation: `privy.walletApi.create({ chainType: "solana" })` on first `/start`
- `walletAddress` extracted from `wallet.address`
- Signing: `getPrivyKitSigner(walletAddress)` → `TransactionPartialSigner` calling `privy.walletApi.solana.signTransaction()`
- Authorization: ED25519 with `PRIVY_AUTHORIZATION_PRIVATE_KEY` for Privy API request signing

### Dev Mode (test signer)
- `TEST_KEYPAIR` env var: base58-encoded Solana keypair
- `initTestSigner()` called at startup, registers in-memory signer
- Auth middleware auto-creates test user with `walletAddress` from keypair, `phoenixActivated=true`
- Blocked in production via Zod `refine()`

### Phoenix Activation
- `POST /v1/invite/activate` with `Authorization: Bearer <BUILDER_ACCESS_CODE>`
- Bot uses a single `BUILDER_ACCESS_CODE` for all users (users don't need their own codes)
- On success: sets `users.phoenixActivated = true` in DB

---

## 9. Referral System

Two-tier, bot-native (independent of Phoenix's native referral requiring $10K volume).

**Code generation**: `crypto.randomBytes(4).toString("hex").toUpperCase()` → 8-char string.

**T1 (direct):**
- User A refers User B with A's code at signup
- Condition: code valid, not self-referral, no existing T1 link for this pair
- Creates: `referrals(referrerId=A.id, refereeId=B.id, tier='t1')`

**T2 (indirect):**
- User B (who was referred by A) refers User C
- Condition: B has a T1 parent (A), no existing T2 link from A to C
- Creates: `referrals(referrerId=A.id, refereeId=C.id, tier='t2')`
- T2 always credits the original T1 referrer (A), not the intermediate (B)
- Chain stops at 2 levels (`eq(referrals.tier, "t1")` filter on parent lookup prevents T3)

**Fee accrual (on every WS fill event, gated by `REFERRAL_ENABLED`):**
```
builderFee = notional × (BUILDER_FEE_BPS / 10000)   // default: 10 bps = 0.1%
T1 rebate = builderFee × 20%                          // 2 bps of notional
T2 rebate = builderFee × 10%                          // 1 bps of notional
UPDATE referrals SET accrued_usdc += rebate WHERE ...
```

**Claim**: `/claim` withdraws if any referral has `accrued_usdc >= 1.0 USDC`. Moves accrued → claimed, sends USDC to user wallet.

---

## 10. Image Generation (`src/services/image.ts`)

Two card types using the Satori → SVG → @resvg/resvg-js → PNG pipeline.

### PnL Card (for `/share`)
- Dimensions: 1200×630px (OG card ratio)
- Background: `assets/win.jpg` or `assets/lost.jpg` based on realized PnL sign
- Gradient overlay (dark left → transparent right) composed via Sharp
- Content: market symbol, direction badge (▲ LONG / ▼ SHORT), realized PnL large, ROI%, entry/exit prices, size, approximate duration
- Fonts: Space Grotesk 400 + 700 (loaded from `assets/fonts/`)
- Credit: "Created by @trankhac_vy" watermark

### Wallet Summary Card (for `/wallet`)
- Same dimensions and layout structure
- Content: truncated wallet address, total realized PnL, win rate, best/worst trade
- Bottom stats bar: fill count, total volume, average trade PnL

### Font Loading
Fonts loaded from disk on first call, cached in memory (`Buffer` references). Avoids repeated file reads per generation.

---

## 11. Error Handling (`src/bot/lib/errors.ts`)

### BotError Class
Structured error with:
- `category`: validation, auth, config, api, network, ratelimit, tx_failed, io, gate, internal
- `code`: specific error code (e.g., `INSUFFICIENT_MARGIN`, `PRICE_DRIFT`, `BLOCKHASH_EXPIRED`, `ISOLATED_ONLY_MARKET`)
- `userMessage`: safe for Telegram display
- `hint`: optional action suggestion
- `retryable`: boolean
- `meta`: arbitrary data for logging

### `toBotError(err)` — Error Classification
Pattern-matches raw errors (SDK, network, Telegram API) against regex/instanceof checks:
- Blockhash expiry → retryable `BLOCKHASH_EXPIRED`
- Insufficient SOL for gas → `INSUFFICIENT_SOL` with deposit hint
- Telegram 429/5xx → retryable `TELEGRAM_API_ERROR`
- Margin errors → `INSUFFICIENT_MARGIN`
- No open position → validation `NO_POSITION`
- Isolated-only market → `ISOLATED_ONLY_MARKET` with `/markets` hint
- Slippage → retryable with "reduce size or widen slippage"
- Network errors (ECONNRESET, timeout, ENOTFOUND) → retryable `NETWORK_ERROR`
- Unknown → `INTERNAL_ERROR` with original message preserved

### `renderBotError(err, opts)` 
Formats error for Telegram with bold title, message, optional hint, retry indicator. Supports edit mode (callbacks) and custom keyboards.

---

## 12. Middleware Stack

### Auth (`middleware/auth.ts`)
- Extracts `telegramId` from `ctx.from.id`
- Queries DB: `users.findFirst({ where: eq(users.telegramId, ...) })`
- Sets `ctx.user` (undefined if not found)
- Dev mode + not found: auto-creates test user from `TEST_KEYPAIR` signer

### Rate Limiting (`middleware/rate-limit.ts`)
Three Redis-backed limiters:

| Limiter | Key | Limit | Window | Applied at |
|---------|-----|-------|--------|-----------|
| General | `ratelimit:<telegramId>` | 20 req | 60s | All updates |
| Orders | `ratelimit:orders:<telegramId>` | 5 orders | 60s | `/long` `/short` confirm callbacks |
| Manual | `checkOrderRateLimit()` | same as orders | 60s | Called explicitly in handlers |

Implementation: `redis.multi().incr(key).expire(key, window, "NX").exec()` — atomic; TTL only set on new key.

### Action Logging (`middleware/action-log.ts`)
Wraps every handler:
- Records: command, args (redacted), start time, outcome (success/error), error code/category, duration, tx signature
- `ctx.actionLog = { skip: true }` suppresses logging for intermediate steps before async execution takes over
- Sensitive field redaction: recursive traversal of args JSONB; replaces values for keys matching: `password`, `apiKey`, `mnemonic`, `seed`, `token`, `privateKey`, `secret`, `authorization` → `[REDACTED]`

---

## 13. Utility Libraries

### Formatting (`bot/lib/fmt.ts`)
- `num(n, min?, max?)` — `Intl.NumberFormat` locale-aware
- `usd(n)` — `$1,234.56` format
- `price(n)` — auto-precision based on magnitude
- `pct(n)` — `+1.23%` with sign
- `funding1h(rate)`, `fundingDir(rate)`, `fundingDot(rate)`, `fundingTrend(rate)`, `fundingDailyUsd(rate, size)` — funding rate display helpers
- `pnlEmoji(pnl)` — ✅ / 🔴 based on sign
- `signedUsd(n)` — `+$1.23` / `-$1.23`
- `cryptoSize(n)` — smart rounding (0.001234 vs 1.23)
- `shortAddr(addr)` — `4Zx3…kF7q` truncated
- `parseAmount(s)` — parses "100", "100.5", throws on invalid
- `parseLeverage(s)` — parses "10", "10x", "10X", "2.5x", validates range
- `compactUsd(n)` — `$1.2M`, `$45K` for large amounts
- `liqDistanceLabel(entry, liq, side)` — `12.5% away` with direction

### Pagination (`bot/lib/paginate.ts`)
`paginate(items, page, pageSize)` → `{ items, page, totalPages }`.
`addPaginationRow(keyboard, prefix, page, totalPages)` adds `◀ Prev` / `Next ▶` row.

### Idempotency (`bot/lib/idempotent.ts`)
`claimIdempotencyKey(userId, callbackId)`: Redis `SET NX EX 120`. Prevents double-execution if user double-taps confirm button. `callbackId` is Telegram's per-callback unique ID.

### Pending State (`bot/lib/pending.ts`)
`setPending(telegramId, action)` / `getPending(telegramId)` / `clearPending(telegramId)`.
Uses Redis `SET key value EX 600` / `GET key` / `DEL key`.

### Retry (`lib/retry.ts`)
`withRetry(fn, { attempts, baseDelayMs, retryIf })` with exponential backoff. Defaults to retrying on rate limits, network errors, timeouts.

---

## 14. Configuration & Environment (`src/config/index.ts`)

All env vars validated at startup via Zod. Crashes on failure with field-level errors (names only in production to avoid leaking secrets).

### Required Variables
| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot API token |
| `PRIVY_APP_ID` | Privy app identifier |
| `PRIVY_APP_SECRET` | Privy API secret |
| `BUILDER_AUTHORITY_PUBKEY` | Phoenix Flight builder pubkey (≥43 chars for real; shorter → stub/no Flight) |
| `HELIUS_RPC_URL` | Solana RPC URL (Helius, for Sender URL extraction) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |

### Optional / Conditional
| Variable | Default | Condition |
|----------|---------|-----------|
| `NODE_ENV` | development | — |
| `PORT` | 3000 | — |
| `HOST` | 0.0.0.0 | — |
| `BUILDER_FEE_BPS` | 10 | range 1–50 |
| `BUILDER_ACCESS_CODE` | "" | — |
| `PHOENIX_API_URL` | https://perp-api.phoenix.trade | — |
| `PHOENIX_WS_URL` | wss://perp-api.phoenix.trade/v1/ws | — |
| `REFERRAL_ENABLED` | false | "true"/"1" to enable |
| `ADMIN_TELEGRAM_IDS` | [] | Comma-separated for `/log` access |
| `WEBHOOK_URL` | — | Production webhook mode |
| `WEBHOOK_SECRET` | — | Required if WEBHOOK_URL set (min 16 chars) |
| `TEST_KEYPAIR` | — | Dev only; **blocked in production** |
| `PRIVY_AUTHORIZATION_PRIVATE_KEY` | — | Required when TEST_KEYPAIR not set |
| `PRIVY_AUTHORIZATION_KEY_ID` | — | Optional |

### Zod Refinements (runtime assertions)
1. `TEST_KEYPAIR` + `NODE_ENV=production` → fail
2. `!TEST_KEYPAIR` + no `PRIVY_AUTHORIZATION_PRIVATE_KEY` → fail
3. `WEBHOOK_URL` set + no `WEBHOOK_SECRET` → fail
4. `WEBHOOK_SECRET` length < 16 → fail

---

## 15. Migration History (`src/db/migrations/`)

8 numbered SQL migration files (0000–0007), plus a parallel numbered set from Drizzle kit:

| File | Content |
|------|---------|
| `0000_wallet_monitors.sql` | Creates `wallet_monitors` table with composite unique (user_id, watched_wallet) |
| `0001_action_logs.sql` | Creates `action_logs` table with JSONB args, indices |
| `0002_clear_ben_grimm.sql` | Drizzle-named: likely schema cleanup |
| `0003_cool_typhoid_mary.sql` | Drizzle-named: schema evolution |
| `0004_mixed_grandmaster.sql` | Drizzle-named: schema evolution |
| `0005_add_last_hydrated_at.sql` | Adds `last_hydrated_at` to `leaderboard_snapshots` |
| `0005_sloppy_ares.sql` | Drizzle-named: parallel branch (naming collision at 0005) |
| `0006_add_metadata.sql` | Adds `metadata` JSONB to `leaderboard_snapshots` |
| `0006_bent_the_hood.sql` | Drizzle-named: parallel 0006 |
| `0007_careful_rogue.sql` | Creates `trades` table with indices |

The `_journal.json` and `0002–0007_snapshot.json` files track Drizzle migration state. The duplicate numbering at 0005 and 0006 suggests two concurrent development branches that both added migrations before being merged.

---

## 16. Testing

### Unit Tests (Vitest, `vitest.config.ts`)
Excludes `tests/integration/`. 9 test files:

| File | What's Tested |
|------|--------------|
| `trade-flow.test.ts` | Leverage parsing (`parseLeverage`), order rate limit checks |
| `errors.test.ts` | `BotError` construction, `toBotError` pattern matching (12+ error patterns), `renderBotError` output |
| `fmt.test.ts` | Funding rate display helpers, liquidation distance labels, number formatting |
| `action-log.test.ts` | Sensitive field redaction — recursive, nested objects and arrays |
| `image.test.ts` | PnL card generates non-empty `Buffer` for both profit and loss trades |
| `lots.test.ts` | `marginToTokens`, `fractionToCloseLots`, `baseLotsToTokens`, min-lot validation |
| `market.test.ts` | `isIsolatedOnly` for GOLD/SILVER/SKR/WTIOIL |
| `preflight.test.ts` | 10+ scenarios: activation gate, invalid margin, ISOLATED_ONLY, collateral check, tier overflow, price drift |
| `referral.test.ts` | Unique code generation |

### Integration Tests (`vitest.integration.config.ts`, 30s timeout)
Requires real DB + Redis. 2 files:

| File | What's Tested |
|------|--------------|
| `alerts.test.ts` | Alert subscription creation, toggling enabled/disabled |
| `referral.test.ts` | T1 linking, T2 chaining, self-referral prevention, no T3 creation |

### Test Setup (`tests/setup.ts`)
Sets `NODE_ENV=test`, stubs all required env vars with dummy values so config validation passes without real credentials.

### Coverage Gaps
1. **Trade execution** — no tests for `placeMarketOrder`, `setTpSl`, `closePosition` (would need Helius + Phoenix API mock)
2. **WS reconnection logic** — backoff timing, failure counter reset, position diff
3. **Leaderboard discovery** — GPA scan, hydration pipeline
4. **Command handlers** — full UI flows (symbol picker, size picker, leverage picker, confirm)
5. **Privy signer** — wallet creation, signing (needs Privy API mock)
6. **allMids + price alert pipeline** — WS → Redis dedup → BullMQ → alert dispatch

---

## 17. Key Design Decisions & Non-Obvious Patterns

**1. Webhook URL slug = sha256(botToken).slice(0,32)**
Avoids exposing the raw token in the URL while keeping it deterministic. Fastify validates `X-Telegram-Bot-Api-Secret-Token` header against `WEBHOOK_SECRET`.

**2. sequentialize(ctx.from.id) as FIFO per user**
grammY's `sequentialize` middleware ensures commands from the same user execute serially. Prevents race conditions in multi-step flows (e.g., two concurrent deposit confirmations).

**3. Pending state as one-key flow context**
Only one pending state per user at a time. New flow overwrites old. This means starting `/deposit` while `/long` is in progress silently cancels the trade flow. Acceptable for the single-Telegram-thread UX.

**4. Anchor price embedded in callback_data**
`confirm:long:SOL:10:500:87000` — anchor price is baked into the button payload. On execute, preflight re-checks drift. This allows detecting price movement between "viewed confirm" and "tapped confirm" without server-side state.

**5. Async fire-and-forget execution from callbacks**
After tapping confirm, the bot edits the message immediately and runs trade execution in a background IIFE. Prevents Telegram's 30-second callback timeout for slow Solana transactions. The handler returns before the trade finishes.

**6. Trade lock (Redis NX, 150s)**
Key: `trade:lock:<userId>`. Prevents overlapping in-flight trades. 150s > expected TX confirmation time (5–30s on Solana with Jito).

**7. Idempotency on callbackQueryId (120s)**
`claimIdempotencyKey(userId, callbackQueryId)` uses Telegram's unique callback ID as a Redis NX key. Prevents double-execution if network delay causes Telegram to re-deliver the callback or user double-taps.

**8. Position cache seeds on first event (no false "opened" alerts)**
When the WS first subscribes to a wallet, there's no prior state. If we diff immediately, every existing position would look "new" and trigger false monitor alerts. The code detects cache miss on first event, seeds the cache, and skips alerting.

**9. ownerUserIdCache with LRU-like eviction at 5000 entries**
```typescript
if (ownerUserIdCache.size >= OWNER_CACHE_MAX) {
  const oldest = ownerUserIdCache.keys().next().value;
  ownerUserIdCache.delete(oldest);
}
```
Prevents unbounded memory growth for high-traffic wallets. Simple FIFO eviction on Map insertion order.

**10. allMids throttle: 1 check/second with running mutex**
Phoenix WS may send allMids updates many times per second. The mutex (`priceAlertCheckRunning`) plus 1s throttle prevents overlapping async DB reads. Price alert cache has a separate 30s TTL to avoid hitting DB on every check.

**11. Jito tip to random account from 10-address pool**
Randomness reduces tip account load concentration. Fixed 200K lamports (~$0.03 at SOL=$150) per trade regardless of trade size.

**12. setTpSl sends each level as a separate transaction**
The for loop calls `dispatchInstruction` sequentially per TP/SL level. This means 2 TP rungs + 1 SL = 3 separate Solana transactions. Atomic batching would be better but requires `dispatchInstructions`.

**13. Builder authority validation by length, not base58 decode**
`BUILDER_AUTHORITY_PUBKEY.length < 43` skips Flight routing. This is a fast check that avoids importing base58 decode just for validation. Hardcoded placeholder pubkeys ("11111...1") are 43 chars — this would be a false positive. The real check is that valid addresses are ≥43 chars.

**14. Phoenix USDC ≠ standard USDC**
Phoenix's collateral token is `PhUsd...` (wrapped). The Rise SDK handles wrapping in `buildDepositIxs` and `buildWithdrawIxs` via the Ember proxy contract. Standard USDC (`EPjFWdd5...`) sits in the user's wallet ATA; Phoenix collateral sits in the protocol PDA.

**15. USDC mint constant hardcoded**
`const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"` in trade.ts. No mainnet/devnet switching logic — the bot is mainnet-only.

---

## 18. Known Limitations & TODOs

| # | Limitation | Location | Notes |
|---|-----------|----------|-------|
| 1 | **TP/SL ladder fractions ignored** | `trade.ts:setTpSl` | Every rung is full-position close. `TODO(ladder-fractions)` comment in code. Fix: switch to `buildPlacePositionConditionalOrder(sizeBaseLots/sizePercent)` |
| 2 | **Isolated margin not supported** | `preflight.ts` | GOLD, SILVER, SKR, WTIOIL throw `ISOLATED_ONLY_MARKET`. Only cross-margin (subaccountIndex=0) used |
| 3 | **No limit orders in UI** | `trade.ts:placeLimitOrder` exists but no command/handler wires it | Market orders only |
| 4 | **Single-process scaling** | `src/main.ts` | GPA scans + WS connections + alert dispatch all in one process |
| 5 | **Leaderboard production-only** | `workers/leaderboard.ts` | Cannot test leaderboard locally without `NODE_ENV=production` |
| 6 | **Referral accrual on every WS fill (no fill-level dedup)** | `ws.ts` | If WS fires the same fill twice, fee accrues twice. WS 5s dedup mitigates but doesn't eliminate |
| 7 | **setTpSl sends separate txs per level** | `trade.ts:setTpSl` | Should batch into `dispatchInstructions` |
| 8 | **No Docker / container setup** | Repo root | Deployment via Coolify; no Dockerfile |
| 9 | **Price alert trigger is one-shot with 1h dedup** | `ws.ts:checkPriceAlerts` | After firing, alert is disabled for 1 hour by Redis TTL. No re-arm mechanism |
| 10 | **Leaderboard hydration aborts on 10 consecutive 429s** | `workers/leaderboard.ts` | Large trader pools may not fully hydrate |

---

## 19. File Count Summary

| Directory | Files | Purpose |
|-----------|-------|---------|
| `src/bot/commands/` | 28 | Command handlers |
| `src/bot/keyboards/` | 3 | Inline keyboard builders (market, position, trade) |
| `src/bot/lib/` | 7 | Bot utilities (fmt, pagination, idempotency, pending, validation, errors, activation) |
| `src/bot/middleware/` | 3 | Auth, rate limit, action log |
| `src/services/phoenix/` | 7 | Exchange integration (client, market, position, preflight, trade, lots, candles) |
| `src/services/` | 6 | Business logic (wallet, referral, leaderboard, image, action-log, trade-log) |
| `src/db/schema/` | 9 | Drizzle table definitions |
| `src/db/migrations/` | 10+ | SQL migrations |
| `src/workers/` | 2 | WS manager, leaderboard scanner |
| `src/jobs/` | 2 | Alert queue definition, alert worker |
| `src/lib/` | 5 | Shared (logger, redis, constants, privy, retry) |
| `src/server/` | 2 | Fastify server, health route |
| `src/config/` | 1 | Zod env validation |
| `src/types/` | 1 | Shared TypeScript types |
| `tests/` | 12 | Unit + integration tests |
| `docs/` | 30+ | Phoenix protocol documentation |
| `scripts/` | 5 | Dev utilities (setup DB, test bot, register test user, verify GPA, test onchain) |
| `data/` | 1 | wallet-tags.json (known wallet metadata) |
| `assets/` | 5 | Fonts (Space Grotesk, Inter), win/loss background images |
| **Total source** | **~120** | |
