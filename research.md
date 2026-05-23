# Phoenix Perp Bot — Deep Research Report

## What It Is

A Telegram trading bot for **Phoenix perpetual futures on Solana**. Users get a server-side embedded Solana wallet (via Privy), fund it with USDC, and trade perps directly from Telegram messages. The bot handles the full lifecycle: wallet creation, Phoenix account activation, order placement, position management, alert delivery, and referral fee accrual.

---

## Process Model

Three independently-deployed Node.js processes (designed for Railway):

| Process | Entry | Role |
|---|---|---|
| **Bot** | `src/main.ts` | grammY bot + Fastify webhook server |
| **WS worker** | `src/workers/ws.ts` | Phoenix WebSocket subscriptions, real-time event handling |
| **Alert worker** | `src/workers/alert.ts` | BullMQ consumer, dispatches Telegram messages |
| **Leaderboard worker** | `src/workers/leaderboard.ts` | GPA + REST hydration of on-chain traders |

Processes communicate exclusively through:
- **BullMQ** (`alertQueue`) — WS worker writes jobs, alert worker processes them
- **Redis pub/sub** (`monitor:events` channel) — bot process notifies WS worker of wallet-monitor changes at runtime

They never call each other over HTTP or import from each other directly (except alert worker importing the bot singleton to call `bot.api.sendMessage`).

**Startup mode**: `NODE_ENV=production && WEBHOOK_URL` → Fastify + Telegram webhook. Otherwise → grammY long-polling (dev).

---

## Bot Request Flow

```
Telegram → POST /webhook/<token>  (Fastify)
  → handleWebhook (grammY webhookCallback)
  → authMiddleware      loads ctx.user from DB by telegramId
  → actionLogMiddleware wraps next(), writes action_logs on exit
  → rateLimitMiddleware 20 req/min global; checked BEFORE commands
  → orderRateLimitMiddleware (applied only to /long, /short): 5 orders/min
  → command handler
```

`ctx.user` is `undefined` for unknown users. Every command (except `/start`) opens with `if (!ctx.user) return ctx.reply("Type /start first.")`.

### Pending input state

Multi-step flows store state in Redis: `pending:<telegramId>` → a colon-delimited string like `trade_size:long:SOL:10`. The global `bot.on("message:text")` handler in `src/bot/index.ts` checks this key and dispatches accordingly. TTL is 600 seconds (10 minutes).

---

## Commands (25 total)

| Command | Description |
|---|---|
| `/start` | Onboarding (wallet creation + referral link). Also handles deep-link payloads: `pos_<symbol>_<side>`, `hist_<idx>_<page>`, `mkt_<symbol>_<page>`. |
| `/activate <code>` | Sends `POST /v1/invite/activate` then `POST /v1/invite/activate-with-referral` as fallback. Sets `phoenixActivated = true` in DB. |
| `/deposit` | Shows QR code of wallet address (generated with `qrcode`). Instructs to send standard USDC + ≈0.01 SOL for gas. |
| `/withdraw [amount]` | Two-phase security: first confirm creates a Redis key, second confirm (≥300 s later) executes `withdrawCollateral`. |
| `/long [symbol] [lev] [size]` | 4-step guided flow (symbol picker → leverage picker → size picker → confirm) or quick-entry shortcut. |
| `/short [symbol] [lev] [size]` | Same as long, opposite side. |
| `/positions` | List view (all open positions with uPnL) + detail view with close, add margin, TP/SL editing. Deep links to each position. |
| `/portfolio` | Account overview: deposited collateral, effective collateral, uPnL, risk tier, SOL balance. |
| `/history` | Paginated trade history with per-trade P&L. Individual trade detail via deep link. |
| `/markets` | Paginated market list with mark price, funding APR, RSI, MACD histogram. Detail view per market. |
| `/alerts` | Toggle 7 alert types on/off. |
| `/pricealert <symbol>` | Set a price threshold alert for a specific market. |
| `/setsl <symbol>` | Set stop-loss price + execution mode (market IOC or limit). |
| `/settp <symbol>` | Set take-profit. Supports ladder TP (25%/50%/100% position close at different prices). |
| `/settings` | Per-user slippage BPS (default 50) and default leverage (default 5). |
| `/referral` | Show referral link, T1/T2 counts, accrued/claimable USDC. |
| `/claim` | Claim accrued referral USDC (marks claimed in DB; no on-chain transfer implemented yet). |
| `/wallet-monitor` | Add/remove/list external wallets to watch (max 10). Alerts on position open/close/flip/fill. |
| `/wallet` | Show wallet address + SOL/USDC balances. |
| `/leaderboard` | Paginated leaderboard sorted by portfolio value, realized PnL, or volume. |
| `/funding` | Live funding rates across all markets. |
| `/export` | Export trade history as CSV. |
| `/share` | Generate and send a P&L card image for a position. |
| `/log` | Show recent action log for the user (audit trail). |

### Navigation callbacks

All `nav:*` callbacks (`nav:long`, `nav:short`, `nav:positions`, `nav:balance`, `nav:deposit`, `nav:withdraw`, `nav:history`, `nav:markets`, `nav:alerts`) are registered in `commands/index.ts` and call the corresponding `send*Screen()` function, allowing inline keyboard navigation without re-entering commands.

---

## Phoenix Integration (`src/services/phoenix/`)

### Client (`client.ts`)

Two singleton `PhoenixClient` instances from `@ellipsis-labs/rise`:
- **`_readClient`** — no flight routing, used for all read-only calls.
- **`_tradingClient`** — includes `flight: { builderAuthority }` if `BUILDER_AUTHORITY_PUBKEY.length >= 43` (guards against stub/placeholder values).

`BASE_CLIENT_OPTIONS`:
```
{ apiUrl, rpcUrl: HELIUS_RPC_URL, exchangeMetadata: { stream: false } }
```

### Market (`market.ts`)

- `getMarkets()` — in-memory cache, 60 s TTL.
- `getMarketSnapshot(symbol)` — parallel: `getMarket`, `getOrderbook`, `getFundingRateHistory(limit:1)`. Returns `MarketSnapshot` with mark price (orderbook mid), tick size, base lots decimals, max leverage, taker/maker fees, funding rate, OI cap, isolated-only flag, and leverage tiers.
- `ISOLATED_ONLY_MARKETS = { GOLD, SILVER, SKR, WTIOIL }` — these always raise `ISOLATED_ONLY_MARKET` in preflight; isolated margin not yet supported.
- Leverage tiers: computed as `{ maxLeverage, maxNotionalUsdc }` from `maxSizeBaseLots * lotToBase * markPrice`.

### Preflight (`preflight.ts`)

`preflightOpen(input)` validates before any trade:
1. `phoenixActivated` check.
2. `isIsolatedOnly` check.
3. Input sanity (margin > 0, leverage ≥ 1).
4. `getMarketSnapshot` (wraps in `UNKNOWN_MARKET` on failure).
5. Live price check (`markPrice > 0`).
6. `getTraderState` for available collateral.
7. Fee calculation: `notional * takerFee + notional * BUILDER_FEE_BPS / 10000`. Checks `totalCost ≤ availableCollateral`.
8. Leverage tier validation: finds the matching tier, ensures notional ≤ tier cap and leverage ≤ tier max.
9. Price drift check: if `anchorPrice` provided, computes `|markPrice - anchorPrice| / anchorPrice`. Compares to `slippageBps / 10000` (from `user_settings`, default 50 bps). Throws retryable `PRICE_DRIFT` if exceeded.
10. Liquidation price approximation: `liqPrice = markPrice * (1 - 1/lev + mmFrac)` for long, inverted for short. `mmFrac = 0.5 / maxLeverage`.

Returns `{ snapshot, effectiveLeverage, notional, feeUsdc, availableCollateral, liqPrice, totalCost }`.

### Trade (`trade.ts`)

All transactions go through a shared `sendInstruction(ix, signer)` → `sendAndConfirm` pipeline:
- **Blockhash cache**: 20 s TTL, avoids repeated `getLatestBlockhash` RPC calls.
- **RPC**: `createSolanaRpc` + `createSolanaRpcSubscriptions` from `@solana/kit`. WebSocket URL derived from RPC URL by replacing `https://` → `wss://`.
- `sendInstructions(ixs, signer)` — sends sequentially, returns last signature.

Key operations:
- `placeMarketOrder` — builds `buildMarketOrderPacket`, calls `placeMarketOrder`.
- `placeLimitOrder` — builds limit order packet, calls `buildPlaceLimitOrder` with `traderPdaIndex: 0`.
- `setTpSl` — iterates TP levels then SL levels; each `buildPlaceStopLoss`. TP: `Direction.GreaterThan` (long) / `LessThan` (short); SL is the opposite. Order kind: `StopLossOrderKind.Limit` or `IOC`.
- `closePosition` — fetches `getTraderStateSnapshot` (raw SDK, not our mapper), finds position by symbol, computes `fractionToCloseLots`, sends IOC `ReduceOnly` market order.
- `cancelStopLoss` — `buildCancelStopLoss` with direction derived from `long_sl | long_tp | short_sl | short_tp`.
- `depositCollateral` / `withdrawCollateral` — `buildDepositIxs` / `buildWithdrawIxs`, amounts in native USDC (6 decimals).
- `addMargin(symbol, wallet, amountUsdc, signer)` — converts to native then calls `depositCollateral`.

### Position (`position.ts`)

`getTraderState(wallet)` → calls `getPhoenixClient().api.traders().getTraderState(wallet)`:
- Finds cross account (`traderSubaccountIndex === 0`) or first account.
- Aggregates positions from ALL subaccounts (cross + isolated).
- Position mapping: `virtualQuotePosition.value <= 0` → long, `> 0` → short.
- Mark price computed as `positionValue.ui / positionSize.ui`.
- Leverage approximated as `round(positionValue / initialMargin)`.
- Total unrealizedPnl and unsettledFunding summed across all subaccounts.

`getTradeHistory(wallet, limit)` / `fetchAllTradeHistory(wallet, maxFills)` — paginated cursor-based history. Trade direction: `baseLotsDelta >= 0` → long. A fill is a "close" if `realizedPnl !== 0`. Maker fills have `instructionType === "UncrossCrank"`.

`computeWalletAnalytics(trades)` — produces: totalFills, totalVolume, realizedPnl, wins/closes/longCount/shortCount/makerCount, bestTrade, worstTrade, perMarket breakdown.

### Lots (`lots.ts`)

- `marginToTokens(snap, marginUsdc, leverage, priceOverride?)` — computes base token size: `(marginUsdc * leverage) / price`, floored to `baseLotsDecimals` precision. Throws `SIZE_TOO_SMALL` if below minimum lot.
- `fractionToCloseLots(rawLots, fraction)` — rounds to nearest lot, returns `BigInt`.
- `baseLotsToTokens(snap, lots)` — `lots * 10^-baseLotsDecimals`.

### Candles (`candles.ts`)

Fetches 60 × 1h candles and computes technical indicators via `technicalindicators`:
- **RSI(14)**
- **MACD(12, 26, 9)** — returns histogram value
- **Bollinger Bands(20, 2)**
- **ATR(14)**

Returns null values if fewer than 20 candles are available.

---

## Wallet Management (`src/services/wallet.ts`)

- `createEmbeddedWallet(telegramId)` — `privy.importUser({ linkedAccounts: [{ type: "telegram", telegramUserId }] })` then `privy.walletApi.createWallet({ chainType: "solana", ... })`. Optionally adds `additionalSigners: [{ signerId: PRIVY_AUTHORIZATION_KEY_ID }]`.
- `getWalletSigner(walletAddress)` — returns a function that calls `privy.walletApi.solana.signTransaction`. **Not currently used** — trades use `getKitSigner` instead.
- `getKitSigner(walletAddress)` — returns `_testSigner` if set, **throws** otherwise. This is the critical gap: the Privy → `@solana/kit` KeyPairSigner bridge is not implemented. Production trades cannot execute without it.
- `initTestSigner()` — decodes `TEST_KEYPAIR` (base58) into a `KeyPairSigner` via `createKeyPairSignerFromBytes`. Idempotent.

---

## Database Schema

PostgreSQL via Drizzle ORM + `postgres.js`. 7 tables:

### `users`
PK: `id` = `telegramId` (string). Fields: `telegram_id` (unique), `username`, `first_name`, `privy_user_id`, `wallet_address`, `phoenix_activated` (bool, default false), `referral_code` (unique), `referred_by`, timestamps.

### `alert_subscriptions`
PK: uuid. FK: `user_id → users.id (cascade)`. `type` is a `pgEnum`: `at_risk | cancellable | liquidatable | fill | tpsl_flip | price | funding_flip | large_funding`. `symbol` nullable (null = all markets). `trigger_price` for price alerts. `enabled` bool.

### `wallet_monitors`
Unique constraint `(user_id, watched_wallet)`. Fields: `label`, `alert_on_fill`, `alert_on_position_change`, `enabled`.

### `user_settings`
PK: `user_id`. `slippage_bps` (default 50), `default_leverage` (default 5).

### `referrals`
`tier` enum: `t1 | t2`. `accrued_usdc` and `claimed_usdc` as `numeric(20,6)`. References `users.id` for both `referrer_id` and `referee_id`.

### `action_logs`
`command`, `args` (jsonb, redacted), `outcome` enum `success|error`, `error_code`, `error_category`, `duration_ms` (bigint), `tx_signature`. Indexed on `(user_id, created_at)` and `(command, created_at)`.

### `leaderboard_snapshots`
Serial PK, unique on `wallet_address`. All financial fields as `numeric(20,6)`. `discovered_via` (`gpa` or `ws_trades`). Indexed on `portfolio_value`, `realized_pnl`, `updated_at`.

---

## Real-Time Systems

### WS Worker (`src/workers/ws.ts`)

**Bootstrap sequence**:
1. Load all users from DB → `subscribeUser(wallet, telegramId)` for each.
2. Load all enabled wallet monitors → `subscribeMonitored(watched, telegramId)` for each.
3. Subscribe to `monitor:events` Redis pub/sub channel for runtime add/remove.
4. `subscribeAllMids()` — single WebSocket to Phoenix `allMids` channel for price alerts.

**Per-wallet WebSocket**: Phoenix `traderState` channel. Each wallet gets its own `WebSocket` instance stored in `connections: Map<string, WebSocket>`.

**In-memory indices**:
- `connections: Map<wallet, WebSocket>`
- `ownerMap: Map<wallet, telegramId>` — maps embedded wallets to their owner
- `watcherIndex: Map<wallet, Set<telegramId>>` — all watchers (including owner)
- `ownerUserIdCache: Map<wallet, userId>` — DB id cache for referral accrual

**Own account events** (`handleOwnAccountEvent`):
1. Compare current positions to `ws:positions:<wallet>` Redis cache (1h TTL). If a position's side changed → queue `tpsl_flip` alert.
2. Check risk tier: if `atRisk | at_risk | cancellable | liquidatable | backstopLiquidatable | highRisk` → queue risk alert.
3. For each fill: queue fill alert + call `accrueReferralFee(userId, notional)`.

**Monitored wallet events** (`handleMonitoredWalletEvent`):
- Diff against Redis cached positions → alerts for new positions (`monitor_open`), flips (`monitor_flip`), closes (`monitor_close`), fills (`monitor_fill`).
- Sends to all watchers except the owner (owner handled separately).

**Reconnection**: 5 s backoff on close, max 3 error failures. After 3 failures sends a `ws-error` alert to the owner.

**allMids / price alerts**:
- Cache DB price alert subscriptions for 30 s.
- For each mid tick, check all subscriptions: if price crossed trigger, set Redis dedup key (`alert:price:<userId>:<symbol>:<trigger>`, 1h TTL) and queue alert.
- Trigger direction: `trigger > 0` means `current >= trigger` (price above); `trigger < 0` means `current <= |trigger|` (price below). This allows both above and below alerts encoded in the sign.

### Alert Worker (`src/workers/alert.ts`)

BullMQ `Worker` on queue `alerts`:
- **Concurrency**: 10
- **Dedup**: Redis NX key `alert:dedup:<telegramId>:<type>:<symbol>`, 5 s TTL. Silently drops duplicates.
- **Sending**: `bot.api.sendMessage(telegramId, message, { parse_mode: "HTML" })`. Note: alert messages use raw HTML strings, not `@grammyjs/parse-mode` entities.
- **Retry**: non-retryable `BotError` → drops job. Retryable → throws → BullMQ retries (3 attempts, exponential backoff, 1 s base).

**Queue config**: `removeOnComplete: 100`, `removeOnFail: 500`.

---

## Leaderboard System

### Discovery

Two parallel methods:
1. **GPA** (`discoverTraderWallets`): `connection.getProgramAccounts(PHOENIX_PROGRAM_ID)` with discriminant filter (SHA-256("account:trader") first 8 bytes at offset 0), data slice `offset:56, length:32` (authority pubkey). Runs every 30 minutes.
2. **WS trades**: One WebSocket per market, `trades` channel. New taker wallets inserted with `upsertDiscoveredWallet`, deduped via Redis NX (`lb:known:<taker>`, 1h TTL).

### Hydration

`hydrateTradersBatch(wallets, concurrency=5, includeHistory)`:
- Concurrency-controlled custom queue (tracks `inFlight` Set, races promises).
- `hydrateTrader`: calls `getTraderState`, aggregates cross + isolated subaccounts. Returns financial snapshot.
- `hydrateTradeHistory` (if `includeHistory`): fetches up to 200 trades, runs `computeWalletAnalytics`.
- Upserts into `leaderboard_snapshots` with conflict resolution on `wallet_address`.

**Schedule**: base scan (no history) every 30 min, history scan every 2 hours. Initial boot does a full scan with history.

### Queries

`getLeaderboard(sortBy, page, pageSize)`:
- Sort columns: `portfolioValue` (default, filters `> '0'`), `realizedPnl` (filters `IS NOT NULL`), `totalVolume`.
- Returns paginated rows + total count.

---

## Referral System (`src/services/referral.ts`)

**Two-tier chain** (bot-native, independent of Phoenix's on-chain referral):

- T1 (direct): referrer gets **20%** of builder fee on referee's trades.
- T2 (indirect): referrer-of-referrer gets **10%**.

**Linking** (`linkReferral`):
1. Find user by `referralCode`.
2. Insert `(referrer, referee, tier: "t1")`.
3. Look up if the referrer themselves was referred (T1 row where `refereeId = referrerId AND tier = 't1'`).
4. If found, insert `(referrer-of-referrer, referee, tier: "t2")`.

**Known bug**: step 3 queries `referrals.refereeId = referrer.id` without filtering `tier = "t1"`, so it could accidentally pick a T2 row and create an incorrect T2 link.

**Accrual** (`accrueReferralFee(userId, notionalUsdc)`):
- Called from WS worker on every fill event.
- `builderFeeUsdc = notional * BUILDER_FEE_BPS / 10000`.
- Finds T1 and T2 rows where `refereeId = userId`. Increments `accrued_usdc` by `fee * ratio`.
- No batch update — two separate `UPDATE` queries per fill.

**Code generation**: 4 random bytes → hex uppercase (`generateReferralCode`).

---

## Error System (`src/bot/lib/errors.ts`)

**`BotError`**: custom Error with `{ category, code, userMessage, hint, retryable, meta, cause }`.

9 categories: `validation | auth | config | api | network | ratelimit | tx_failed | io | gate | internal`.

20 error codes: `INVALID_INPUT | SIZE_TOO_SMALL | LEV_OUT_OF_RANGE | UNKNOWN_MARKET | NOT_REGISTERED | NO_WALLET | PHOENIX_NOT_ACTIVATED | INSUFFICIENT_MARGIN | ISOLATED_ONLY_MARKET | TIER_OVERFLOW | PRICE_DRIFT | NO_POSITION | MARKET_CLOSED | BLOCKHASH_EXPIRED | INSUFFICIENT_SOL | SLIPPAGE_EXCEEDED | TX_REVERTED | RATE_LIMIT | NETWORK | UNKNOWN`.

**`toBotError(err)`**: converts any unknown error to `BotError`. First checks `instanceof BotError`, then tests 10 regex patterns against `err.message` (SDK error strings, rate limit, network errors). Falls back to `UNKNOWN`.

**`renderBotError(ctx, err, opts)`**: formats and sends/edits message. Uses `fmt` tagged template with bold header, user message, italic hint, retry indicator.

---

## Action Logging (`src/services/action-log.ts`)

Every Telegram interaction is logged to `action_logs`:
- **Source**: `actionLogMiddleware` in `src/bot/middleware/action-log.ts`. Wraps `next()`, catches errors and classifies them via `toBotError`.
- Commands: parsed from `/command args` text. Callback queries: `cb:<first-segment>` with full `data`.
- `trackAction(meta, fn)` — alternative wrapper for explicit service calls (used in trade execution).
- **Redaction**: `redactArgs` strips values for keys matching `{ password, privateKey, private_key, apiKey, api_key, secret, token, mnemonic, seed }` → replaces with `"[REDACTED]"`. Handles nested objects, arrays, Dates, Buffers, Errors, bigints.
- **ID generation**: `${Date.now().toString(36)}-${random.toString(36).slice(2,10)}`.
- **Retention**: daily cleanup in `main.ts` deletes rows older than 30 days via `sql` template.

---

## Message Formatting

The project strictly uses `@grammyjs/parse-mode`:

```typescript
import { fmt, FormattedString } from "@grammyjs/parse-mode";

const msg = fmt`${FormattedString.b("BTC · LONG")}  Entry ${FormattedString.b("$87,000")}`;
await ctx.reply(msg.text, { entities: msg.entities });

// For photos/files use .caption and .caption_entities
```

Helpers: `.b()` bold, `.i()` italic, `.u()` underline, `.code()` monospace, `.link(text, url)` hyperlink. `FormattedString.join(arr, sep)` for building lists.

**Never** pass `parse_mode: "HTML"` to `ctx.reply` (except in alert worker, which uses raw HTML for alert messages — an inconsistency).

Always `link_preview_options: { is_disabled: true }` when messages contain URLs.

---

## Image Generation (`src/services/image.ts`)

P&L card (1200×630 PNG) using **Satori** (SVG) → **Sharp** (PNG):
- Background: `win.jpg` or `lost.jpg` from `assets/`, base64 inlined.
- Overlay: left-to-right gradient darkening left 45%, then fading to transparent.
- Font: Space Grotesk (Regular 400 + Bold 700) from `assets/fonts/*.ttf`, loaded once and cached.
- Layout: fixed-position elements (symbol, side, entry/exit prices, P&L USDC, ROI %, branding).
- Output: `Buffer` (PNG bytes) → sent as `new InputFile(buffer, "pnl.png")` to `ctx.replyWithPhoto`.

---

## Formatting Utilities (`src/bot/lib/fmt.ts`)

| Function | Behavior |
|---|---|
| `num(n, minDec, maxDec)` | `toLocaleString("en-US")` |
| `usd(n)` | `$1,234.56` style |
| `price(n)` | Dynamic decimals: ≥1000→2dec, ≥1→2dec, ≥0.01→4dec, else 6dec |
| `pct(n)` | `+1.23%` with sign |
| `fundingApr(rate)` | `rate * 1095 * 100` (3 funding periods/day × 365) |
| `compactUsd(n)` | `$1.2M`, `$123K`, `$1,234` |
| `fundingTrend(rates)` | Analyzes last 3 rates' deltas → `↑↑ ↑ → ↓ ↓↓` |
| `timeAgo(ts)` | Handles both ms and s timestamps |
| `shortAddr(addr)` | `ABcd...wxyz` |
| `solscanUrl(sig)` | `https://solscan.io/tx/<sig>` |
| `parseAmount(raw)` | Strips `$`, `,`, spaces then parseFloat |
| `parseLeverage(raw)` | Strips `x`/`X` then parseFloat |

---

## Retry Utility (`src/lib/retry.ts`)

`withRetry(fn, { attempts=3, baseDelayMs=1000, retryIf? })`:
- Default retry condition: `/rate.?limit|429|network|ECONNRESET|timeout|ETIMEDOUT|fetch failed/i`.
- Exponential backoff: `baseDelayMs * 2^i`.
- Used in market snapshot, position fetching, GPA discovery.

---

## Configuration (`src/config/index.ts`)

Zod schema validated at startup. Cross-field refinements:
1. `TEST_KEYPAIR` must not be set in `production`.
2. `PRIVY_AUTHORIZATION_PRIVATE_KEY` required when `TEST_KEYPAIR` is absent.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `TELEGRAM_BOT_TOKEN` | required | |
| `WEBHOOK_URL` | optional | Activates webhook mode + Fastify |
| `PRIVY_APP_ID/SECRET` | required | |
| `PRIVY_AUTHORIZATION_PRIVATE_KEY` | required in prod | |
| `PRIVY_AUTHORIZATION_KEY_ID` | optional | Needed for bot-first wallet signing |
| `BUILDER_AUTHORITY_PUBKEY` | required | Flight routing if length ≥ 43 |
| `BUILDER_FEE_BPS` | `10` | 1–50, taker-only |
| `TEST_KEYPAIR` | optional | Dev only, base58 keypair |
| `PHOENIX_API_URL` | `https://perp-api.phoenix.trade` | |
| `PHOENIX_WS_URL` | `wss://perp-api.phoenix.trade/v1/ws` | |
| `HELIUS_RPC_URL` | required | |
| `DATABASE_URL` | required | postgres.js connection string |
| `REDIS_URL` | required | BullMQ + ioredis |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |

---

## Testing

**Framework**: Vitest 2.x, node environment.

**Unit tests** (`tests/unit/`):
- `lib/errors.test.ts` — `toBotError` classification, `BotError` construction
- `services/action-log.test.ts` — `redactArgs` for sensitive keys, nested objects, arrays
- `services/image.test.ts` — `generatePnlCard` output shape
- `services/lots.test.ts` — `marginToTokens`, `fractionToCloseLots`, `baseLotsToTokens`
- `services/market.test.ts` — snapshot building, isolated-only detection
- `services/preflight.test.ts` — all preflight validation branches
- `services/referral.test.ts` — `generateReferralCode` format

**Integration tests** (`tests/integration/`):
- `alerts.test.ts` — toggle behavior, DB state
- `referral.test.ts` — `linkReferral` T1/T2 chain, `accrueReferralFee` math

`tests/setup.ts` — mocks env vars so Zod config parse doesn't crash.

---

## Known Bugs (from CLAUDE.md)

1. **`src/bot/commands/alerts.ts`** — `findFirst` for toggle missing `type` filter (uses `isNull(symbol)` filter only; fixed in current code with `and(eq(type), isNull(symbol))`). Actually this was fixed — current code has the correct filter.

2. **`src/bot/commands/deposit.ts`** — No bug visible in current code; uses `new InputFile(qr, "deposit-qr.png")` correctly.

3. **`src/bot/commands/long.ts` + `short.ts`** — Confirm callback regex `confirm:long:([A-Z0-9]+):([\d.]+):([\d.]+):([\d.]+)` — `[\d.]+` rejects leverage/size values with decimals that aren't digits or dots (e.g. a negative anchor). Also anchor price has 8 decimal places in the callback data which is fine, but the regex `[\d.]+` doesn't handle edge cases properly.

4. **`src/services/referral.ts:28`** — T2 lookup queries `referrals.refereeId = referrer.id` without `eq(referrals.tier, "t1")`. If the referrer already has a T2 row (someone referred them at T2 level), it could pick that row instead and link incorrectly.

5. **`src/services/wallet.ts:52`** — `getKitSigner` throws unless `TEST_KEYPAIR` is set. All order placement, close, TP/SL, deposit, withdraw operations are broken in production because the Privy → `@solana/kit` `KeyPairSigner` bridge is not implemented. This is the **most critical missing piece**.

6. **`vitest.config.ts`** — The main vitest config exists. An `vitest.integration.config.ts` is referenced in `package.json` but its existence needs verification.

---

## Dependency Highlights

| Package | Version | Role |
|---|---|---|
| `@ellipsis-labs/rise` | ^0.4.9 | Phoenix perp SDK |
| `grammy` | ^1.31.0 | Telegram bot framework |
| `@grammyjs/parse-mode` | ^2.3.0 | Safe entity-based message formatting |
| `@privy-io/server-auth` | ^1.20.0 | Embedded wallet creation |
| `@solana/kit` | ^6.9.0 | Transaction building (modern, kit-style) |
| `@solana/signers` | ^6.9.0 | KeyPairSigner, signing |
| `@solana/web3.js` | ^1.98.0 | Connection, PublicKey (legacy, for GPA) |
| `drizzle-orm` | ^0.38.0 | ORM |
| `bullmq` | ^5.34.0 | Job queue |
| `ioredis` | ^5.4.1 | Redis client |
| `satori` | ^0.10.14 | SVG rendering from React-like tree |
| `sharp` | ^0.33.5 | PNG conversion |
| `technicalindicators` | ^3.1.0 | RSI, MACD, BB, ATR |
| `fastify` | ^5.2.0 | Webhook server |
| `ws` | ^8.20.1 | Raw WebSocket for Phoenix WS API |
| `qrcode` | ^1.5.4 | QR code for deposit address |
| `zod` | ^3.24.0 | Config validation |
| `pino` | ^9.6.0 | Structured logging |

---

## Key Architectural Decisions & Specifics

1. **Server-side signing**: Privy creates wallets, bot signs on behalf of users. Users never hold keys. Critical dependency: Privy authorization keys must be configured in dashboard.

2. **`uuid` pinned to `^9`**: `pnpm.overrides.uuid: "^9.0.0"` to fix `rpc-websockets` CJS/ESM conflict.

3. **ESM throughout**: `"type": "module"`, `"moduleResolution": "NodeNext"`. All imports use `.js` extensions pointing to `.ts` source. No `require()` anywhere.

4. **Two Redis clients in WS worker**: the main `redis` client from `lib/redis.ts` is used for caching and BullMQ. A separate `new Redis(REDIS_URL)` is created for pub/sub subscription (ioredis requires a dedicated connection for `subscribe`).

5. **Ticker → Phoenix symbol**: `symbol.toUpperCase().replace(/-PERP$/i, "")` then `riseSymbol(...)`. Users can type `SOL/USD`, `SOL/USDT`, or `SOL` — all normalized.

6. **Withdrawal security delay**: 5-minute two-phase confirmation stored in Redis (`withdraw:pending:<userId>`). User must click confirm twice with ≥300 s between.

7. **Leaderboard discriminant**: SHA-256("account:trader") first 8 bytes = `[41, 97, 73, 105, 110, 214, 112, 9]`. Authority at byte offset 56, length 32. Hard-coded to Phoenix program ID `EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih`.

8. **Deep links**: Position, history entry, and market detail pages are accessible via `t.me/<bot>?start=pos_<symbol>_<side>`, `hist_<idx>_<page>`, `mkt_<symbol>_<page>`. The `/start` handler routes these for existing users.

9. **Price alert encoding**: `triggerPrice > 0` means alert when price ≥ trigger. Negative trigger means alert when price ≤ |trigger|. Both directions stored in one field.

10. **No Privy bridge**: `getKitSigner` is a stub. Every on-chain action in production would throw. The expected implementation is a bridge from `privy.walletApi.solana.signTransaction` to the `@solana/kit` `KeyPairSigner` interface.
