# Phoenix Perp Bot — Deep Research Report

## What It Is

A Telegram bot that lets users trade perpetual futures on the [Phoenix DEX](https://phoenix.trade) (Solana) — entirely from Telegram. Users get a custodial Privy-managed Solana wallet, deposit USDC, and place leveraged long/short orders without ever leaving the chat.

---

## Process Architecture

Three independently deployable Railway services:

| Process | Entry | Role |
|---|---|---|
| Bot | `src/main.ts` | grammY bot + Fastify webhook (or long-poll in dev) |
| WS worker | `src/workers/ws.ts` | Phoenix WebSocket subscriptions, fill/risk detection |
| Alert worker | `src/workers/alert.ts` | BullMQ consumer, dispatches Telegram messages |

**Data flow:**
```
Telegram → Fastify /webhook/<token>
  → authMiddleware (load ctx.user from DB)
  → actionLogMiddleware (writes action_logs row)
  → rateLimitMiddleware (Redis INCR, 20 req/min)
  → command handler

WS worker → detects event → alertQueue.add(job)
Alert worker → dedup via Redis NX (5s) → bot.api.sendMessage
```

The three processes never call each other directly. They communicate only through Redis pub/sub (`monitor:events`) and BullMQ (`alerts` queue).

---

## Identity & Wallet Model

- **Primary key everywhere:** `telegramId` (string form of Telegram user ID)
- **Wallet creation:** Privy (`@privy-io/node`) creates an **app-owned embedded Solana wallet** at `/start`. App-owned means the bot holds the authorization key and can sign server-side without a user JWT.
- **Signing in production:** `getPrivyKitSigner()` fetches the Privy wallet ID from DB, then creates a `SolanaKitSigner` from `@privy-io/node/solana-kit` — no user interaction required.
- **Signing in dev:** `TEST_KEYPAIR` env var loads a local base58 keypair via `initTestSigner()`. authMiddleware auto-creates a DB row for any Telegram user when this is set (dev shortcut).
- **Zod config validation:** `src/config/index.ts` crashes the process with field-level errors on startup if any required env var is missing or invalid. Production refuses to start with `TEST_KEYPAIR` set.

---

## Phoenix SDK Integration (`@ellipsis-labs/rise`)

- **Two singleton clients:** `getPhoenixClient()` (read-only) and `getTradingClient()` (has Flight builder fee routing).
- **Builder fee:** 10–15 bps taker-only, set via `BUILDER_FEE_BPS`. Builder activates users via `POST /v1/invite/activate`. Users need an invite code or referral code to unlock trading.
- **Account model:** Phoenix PDA = `(wallet_authority, portfolio_index, subaccount_index)`. `subaccount_index=0` = cross-margin; `>0` = isolated.
- **Isolated-only markets:** `GOLD`, `SILVER`, `SKR`, `WTIOIL` — blocked in all trade flows; the bot shows a "coming soon" message.
- **Phoenix USDC:** `PhUsd…` is wrapped via the Ember proxy contract. Deposit/withdraw flow goes through `buildDepositIxs` / `buildWithdrawIxs` from the SDK.

---

## Transaction Pipeline (`src/services/phoenix/trade.ts`)

Every on-chain operation follows this exact path:

1. `client.exchange.ready()` — wait for SDK to sync exchange state
2. Build instruction via SDK (`placeMarketOrder`, `buildPlaceStopLoss`, `buildDepositIxs`, etc.)
3. `addSignersToInstruction([signer], ix)` — attach the Privy signer
4. Compose versioned transaction with:
   - `SetComputeUnitPrice` (200,000 micro-lamports)
   - `SetComputeUnitLimit` (250,000 CU)
   - The main instruction(s)
   - SOL transfer to a random Jito tip account (200,000 lamports / 0.0002 SOL)
5. Sign with `signTransactionMessageWithSigners`
6. Send base64-encoded tx to Helius Sender (`https://sender.helius-rpc.com/fast`) — skip preflight, maxRetries=0
7. `pollConfirmation` — polls every 2s up to 60 attempts (120s), checks slot against `lastValidBlockHeight`

Multiple instructions (e.g., TP + SL together) are batched into one transaction via `dispatchInstructions`.

**Blockhash caching:** `getBlockhash()` caches for 20s to avoid hammering RPC on sequential operations.

---

## Trade Flow (Size-First UX)

```
/long or /short
  → sendSymbolPicker (paginated market list with deep links)
  → trade:long:SYMBOL callback
  → sendSizeStep (balance check, sizePickerKeyboard with % presets)
  → trade_size:long:SYMBOL:AMT callback  OR  text input (trade_size_input:long:SYMBOL)
  → sendLevStep (leveragePickerKeyboard, funding cost note)
  → trade_lev:long:SYMBOL:AMT:LEV callback  OR  text input (trade_lev_input:long:SYMBOL:AMT)
  → sendTradeConfirm (preflightOpen, shows notional/fee/liq estimate, embeds anchorPrice)
  → confirm:long:SYMBOL:LEV:SIZE:ANCHOR callback
      → preflightOpen again (validates drift vs anchor)
      → marginToTokens → placeMarketOrder → pollConfirmation
      → subscribeUser (starts WS monitoring for new trader)
      → success message with Solscan link + "Set stop loss" button
```

**One-liner shortcut:** `/long BTC 10x 500` skips picker and goes straight to confirm.

**Price drift guard:** anchor price encoded in confirm callback as `toPrecision(12)`. If mark price drifts > `slippageBps/10000` (default 50 bps) since the quote was shown, `preflightOpen` throws `PRICE_DRIFT` and shows a "Refresh price" button instead of erroring out.

---

## Preflight Validation (`src/services/phoenix/preflight.ts`)

Before any trade confirm, `preflightOpen` runs these checks in order:

1. `phoenixActivated` flag on user row
2. Not an isolated-only market
3. Finite positive margin and leverage
4. Market exists and has a live price
5. Effective collateral ≥ margin + fee (`totalCost`)
6. Leverage tier check (notional must fit within a tier, leverage must not exceed tier cap)
7. Price drift check (only when `anchorPrice` is provided — i.e., at execution time, not at quote time)

Estimated liquidation price: `markPrice * (1 - 1/leverage + mmFrac)` for longs, where `mmFrac = 0.5 / maxLeverage`.

---

## WebSocket Worker (`src/workers/ws.ts`)

On bootstrap:
1. Loads all users from DB → `subscribeUser(wallet, telegramId)` for each
2. Loads all enabled wallet monitors → `subscribeMonitored(watchedWallet, telegramId)`
3. Subscribes `monitor:events` Redis channel to receive runtime add/remove events
4. Subscribes `allMids` channel for price alert checking

**Per-wallet WS:** One `WebSocket` connection to `PHOENIX_WS_URL` per wallet. Subscribes to `traderState` channel. Reconnects after 5s on close, gives up after 3 consecutive errors (sends an alert to owner).

**Own-account events handled:**
- Position side flip detected → `tpsl_flip` alert (TP/SL cancelled by protocol)
- Risk tier in alert set → risk alert
- Fills → fill alert + `accrueReferralFee()`

**Monitored-wallet events handled:**
- New position opened → `monitor_open` alert to all watchers
- Position side flipped → `monitor_flip` alert
- Position closed → `monitor_close` alert
- Fill → `monitor_fill` alert

**Price alerts:** `allMids` WS streams all market mid prices. `getPriceAlertSubs()` loads enabled price-type subscriptions with 30s TTL cache. When price crosses trigger, fires alert + sets `alert:price:userId:symbol:trigger` Redis key (1h dedup) to prevent re-firing.

---

## Alert Pipeline (`src/jobs/processors/alert.ts`)

- BullMQ worker on `alerts` queue, concurrency 10
- Dedup: `alert:dedup:<telegramId>:<type>:<symbol>` with 5s NX TTL
- Sends via `bot.api.sendMessage` with `parse_mode: "HTML"` (note: alerts use raw HTML strings, unlike bot commands which use `@grammyjs/parse-mode`)
- Non-retryable Telegram errors are dropped with a log warning; retryable errors throw to trigger BullMQ retry

---

## Deposit Flow (2-Step)

**Step 1 — Receive USDC:**
- `/deposit` → shows wallet address + QR code (generated via `qrcode` npm package)
- User sends standard USDC (`EPjFWdd5…`) to Privy wallet

**Step 2 — Add Collateral:**
- "I've sent USDC" button → `getWalletUsdcBalance()` checks actual USDC token accounts
- "Add all" or "Custom amount" → `depositCollateral(walletAddress, amountUsdcNative)`
- Calls `client.ixs.buildDepositIxs` which wraps USDC into Phoenix USDC via Ember proxy

---

## Withdrawal Flow

Has a **5-minute security delay**:
1. First confirm tap → sets `withdraw:pending:<userId>` Redis key (TTL 6min), shows "confirm again in 5 minutes"
2. Second tap (after 300s elapsed) → executes `withdrawCollateral`

---

## TP/SL Implementation

Both TP and SL use `buildPlaceStopLoss` from the Rise SDK:
- **SL:** `StopLossOrderKind.IOC` (market fill), direction = LessThan for longs
- **TP:** `StopLossOrderKind.Limit`, direction = GreaterThan for longs

**Known limitation:** `setTpSl` calls `dispatchInstruction` in a `for...of` loop (one tx per level) instead of batching all into one tx via `dispatchInstructions`. This means setting TP + SL issues 2 separate transactions.

Cancel uses `buildCancelStopLoss` with appropriate `Direction`.

---

## Referral System

**Bot-native referral (independent of Phoenix's native program):**
- Every user gets a random 8-hex referral code at signup
- T1: direct referral — earns 20% of builder fee from referee's trades
- T2: referrer's referrer — earns 10% of builder fee

**Fee accrual:** `accrueReferralFee(userId, notional)` called from WS worker on every fill. Computes `builderFeeUsdc = notional * BUILDER_FEE_BPS / 10000`, then updates `referrals.accrued_usdc`.

**Known bug:** `linkReferral` looks up the referrer's own T1 row without the `eq(referrals.tier, "t1")` filter, so a T2 row can be selected as the T2 parent, creating wrong chains.

---

## Leaderboard System

**Discovery:** Leaderboard worker (`src/workers/leaderboard.ts`) runs a Solana GPA (getProgramAccounts) against the Phoenix program ID every 30 minutes, extracting authority pubkeys from `Trader` accounts (discriminant: first 8 bytes of SHA-256("account:trader"), authority at offset 56).

**Additional discovery:** WS subscription to `trades` channel for every market — new taker wallets are upserted into `leaderboard_snapshots` with `discoveredVia: "ws_trades"`.

**Hydration:** `hydrateTradersBatch` with concurrency=5 calls `getTraderState` per wallet and upserts into DB. Every 2 hours, includes trade history analytics (volume, realized PnL, win/loss counts).

**Display:** `/leaderboard` shows paginated table sorted by portfolio value, realized PnL, or volume. Each row shows shortened wallet address, metric, unrealized PnL emoji, and position count.

---

## Image Generation (`src/services/image.ts`)

Two card types rendered with Satori (SVG) + Sharp (PNG):

**PnL Card** (shown after closing a position):
- 1200×630 px
- Win/loss background JPEG (`assets/win.jpg` / `assets/lost.jpg`)
- Dark left-to-right gradient overlay
- Left panel: market symbol, direction badge (LONG/SHORT with leverage), realized PnL, ROI%
- Bottom bar: entry, exit, size, duration stats
- Font: Space Grotesk (loaded from `assets/fonts/`)

**Wallet Summary Card** (used by `/share` command):
- Same shell, different content: trader address, total PnL, win rate, best/worst trade

---

## Technical Indicators (`src/services/phoenix/candles.ts`)

Market detail view shows 1H indicators computed from the last 60 candles:
- **RSI(14):** overbought >70, oversold <30
- **MACD(12,26,9):** histogram sign = bullish/bearish
- **Bollinger Bands(20, 2σ):** upper/lower shown
- **ATR(14):** volatility measure

Uses `technicalindicators` npm package.

---

## Middleware Stack

| Middleware | File | What it does |
|---|---|---|
| authMiddleware | `middleware/auth.ts` | Loads `ctx.user` from DB by telegramId; dev shortcut creates user from TEST_KEYPAIR |
| actionLogMiddleware | `middleware/action-log.ts` | Writes action_logs rows for commands/callbacks |
| rateLimitMiddleware | `middleware/rate-limit.ts` | 20 req/min per user (Redis INCR) |
| orderRateLimitMiddleware | `middleware/rate-limit.ts` | 5 orders/min, applied only to `/long` and `/short` commands |

---

## Pending State Machine

Multi-step flows (text input required) use Redis key `pending:<telegramId>` → action string. The free-text handler in `bot/index.ts` dispatches on this key pattern:

| Key pattern | Context |
|---|---|
| `withdraw_amount` | Withdraw amount entry |
| `deposit_amount` | Deposit custom amount |
| `trade_size_input:side:SYMBOL` | Custom trade size |
| `trade_lev_input:side:SYMBOL:AMT` | Custom leverage |
| `pricealert:SYMBOL` | Price alert trigger price |
| `addmargin:SYMBOL` | Add margin amount |
| `editsl:SYMBOL:side` | Edit SL price |
| `edittp:SYMBOL:side` | Edit TP price |
| `monitor_add` | Wallet address to monitor |

---

## DB Schema Summary

| Table | Key fields |
|---|---|
| `users` | id=telegramId, privy_user_id, privy_wallet_id, wallet_address, phoenix_activated, referral_code |
| `alert_subscriptions` | user_id, type (pgEnum), symbol, trigger_price, enabled |
| `referrals` | referrer_id, referee_id, tier (t1/t2), accrued_usdc, claimed_usdc |
| `leaderboard_snapshots` | wallet_address (unique), portfolio_value, realized_pnl, total_volume |
| `wallet_monitors` | user_id + watched_wallet (unique), enabled |
| `action_logs` | user_id, command, args jsonb, outcome, tx_signature |
| `user_settings` | user_id PK, slippage_bps=50, default_leverage=5 |

All managed with Drizzle ORM + postgres.js. Migrations in `src/db/migrations/`.

---

## Error Handling

**`BotError` class** (`src/bot/lib/errors.ts`):
- Typed categories: `validation`, `auth`, `config`, `api`, `network`, `ratelimit`, `tx_failed`, `io`, `gate`, `internal`
- Typed codes: 20+ specific codes (PRICE_DRIFT, INSUFFICIENT_MARGIN, TIER_OVERFLOW, etc.)
- `retryable` flag controls whether BullMQ retries alert jobs

**`toBotError()`:** Converts any unknown error to `BotError` by pattern-matching against 10 SDK error regexes (isolated margin, insufficient SOL, blockhash expired, rate limit, network errors, etc.).

**`renderBotError()`:** Renders user-facing error message using `fmt` tagged template. Shows hint + "safe to retry" footnote when retryable. Can edit existing message or send new one.

---

## Known Bugs (from CLAUDE.md)

1. **`alerts.ts`** — alert toggle `findFirst` missing `type` filter → toggles wrong subscription
2. **`deposit.ts` + `share.ts`** — `replyWithPhoto` receives raw `Uint8Array` instead of `new InputFile(...)` → **currently broken**, photos won't send (this is already fixed in the code I read — `new InputFile(card, "pnl.png")` is present in `positions.ts` and `share.ts`)
3. **`referral.ts`** — T2 chain lookup missing `eq(referrals.tier, "t1")` filter → wrong T2 parent possible
4. **`ws` / `@types/ws`** — not listed in `package.json` but used in `ws.ts` and `leaderboard.ts` (actually present in `dependencies` in the package.json I read — this may be stale)

---

## Commands Reference

| Command | Description |
|---|---|
| `/start` | Onboard + create wallet; deep-link dispatch for pos/hist/mkt/trade |
| `/activate <code>` | Activate Phoenix trading account |
| `/deposit` | 2-step USDC deposit flow |
| `/withdraw [amount]` | Withdraw with 5-min security delay |
| `/long [symbol] [lev] [size]` | Open long position |
| `/short [symbol] [lev] [size]` | Open short position |
| `/positions` | List/manage open positions |
| `/portfolio` | Account overview (balances, positions, risk tier) |
| `/markets` / `/market <sym>` | Market list / detail (price, OI, funding, TA indicators) |
| `/history` | Paginated trade history |
| `/setsl <sym> <price>` | Set stop loss (interactive picker or direct) |
| `/settp <sym> <price>` | Set take profit |
| `/funding` | Top 10 funding rates |
| `/leaderboard` | Global trader leaderboard |
| `/referral` | Referral stats + link |
| `/claim` | Claim referral rebate |
| `/alerts` | Toggle alert subscriptions |
| `/pricealert <sym>` | Set a price alert |
| `/monitor [address]` | Monitor external wallet |
| `/wallet` | Show wallet address + balance |
| `/export` | Export wallet private key |
| `/share <sym>` | Generate PnL card image for sharing |
| `/settings` | User settings (slippage, default leverage) |
| `/log` | Recent action log |

---

## Observations and Non-Obvious Specifics

1. **No real-time price feed in the bot process** — all prices are fetched from Phoenix REST API at request time. WS price stream is only in the WS worker (for price alerts). The bot's `sendTradeConfirm` is a point-in-time snapshot.

2. **Anchor price precision** — `anchorStr = entry.toPrecision(12)` is stored in callback_data. The old code used `toFixed(8)` which caused issues with very small tick sizes (e.g., SHIB).

3. **Side determination in fills** — `virtualQuotePosition.value <= 0` means long (you've received base, given quote). This is the inverted convention that trips up the trade history interpretation: a "short fill" = closing a long position.

4. **allMids price alert precision** — trigger price stored as negative number for "below" alerts (`trigger > 0 ? current >= trigger : current <= Math.abs(trigger)`). Negative trigger = "alert me when price falls below this absolute value."

5. **Leaderboard GPA parsing** — Phoenix Trader account discriminant hardcoded as 8 bytes. Authority pubkey at byte offset 56. No SDK used for this — raw account data slicing.

6. **Jito tip randomization** — 10 Jito tip accounts rotated randomly per transaction. Both single and multi-instruction paths include the tip.

7. **Market cache TTL** — `getMarkets()` caches 60s. Market snapshots fetched fresh per request (no cache) — potentially expensive for symbol picker which calls `getMarketSnapshot` for each page item in parallel.

8. **`nav:activate` callback** — registered nowhere explicitly; the `registerActivate` function only registers the `/activate` command. Tapping "Activate account" button in trade flow will silently fail (noop-like behavior since no handler exists for `nav:activate`).

9. **`BUILDER_ACCESS_CODE` env var** — referenced in CLAUDE.md but not in the Zod config schema or code. Removed or not yet implemented.

10. **Alert worker uses raw HTML** — `bot.api.sendMessage(telegramId, message, { parse_mode: "HTML" })` while all bot commands use `@grammyjs/parse-mode` entities. Inconsistency; alert messages from WS worker (e.g., risk tier messages) contain raw `<b>` tags.

11. **Action log retention** — `main.ts` runs a daily sweep deleting `action_logs` older than 30 days. Runs immediately on startup then every 24h.

12. **Wallet monitor pub/sub** — when bot adds/removes a monitor, it publishes to `MONITOR_EVENTS_CHANNEL` Redis channel. WS worker subscribes to this and dynamically updates its in-memory subscription maps without requiring restart.

13. **`subscribeUser` called after every trade** — idempotent (checks `connections.has` before creating WS). Ensures new traders automatically get live alerts after first position.
