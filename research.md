# Phoenix Perp Bot — Deep Research Report

## 1. What This Project Is

A Telegram-based perpetual futures trading bot for **Phoenix Protocol** on Solana. Users interact entirely through Telegram commands (no web UI). The bot manages wallets via Privy custody, routes trades through the Rise/Phoenix SDK, streams live risk data via WebSocket, and dispatches asynchronous alerts through a BullMQ job queue.

---

## 2. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22+, TypeScript 5.7 (ESM, NodeNext modules) |
| Bot framework | grammY |
| Blockchain | @solana/kit + @ellipsis-labs/rise (Phoenix SDK) |
| Wallet custody | Privy (server-side embedded wallets) |
| Database | PostgreSQL via Drizzle ORM (postgres.js) |
| Job queue | BullMQ (backed by Redis) |
| Cache / state | IoRedis |
| HTTP server | Fastify (webhook mode) |
| Image generation | satori (JSX → SVG) + sharp (SVG → PNG) |
| Linter/formatter | Biome 1.9.4 |
| Tests | Vitest (unit + integration) |
| Package manager | pnpm 10.15+ |

---

## 3. Process Architecture

Three independently deployed processes (intended for separate Railway services):

```
┌──────────────────────────────────────────────────────────────┐
│  Bot process  (src/main.ts)                                  │
│  grammY + Fastify webhook server                             │
│  Handles all Telegram commands and user interactions         │
└──────────────────┬───────────────────────────────────────────┘
                   │ writes jobs to BullMQ
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Alert worker  (src/workers/alert.ts)                        │
│  BullMQ consumer → dedup → bot.api.sendMessage               │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  WS worker  (src/workers/ws.ts)                              │
│  Phoenix WebSocket subscriptions                             │
│  Detects fills, risk changes, price alerts → alertQueue      │
└──────────────────────────────────────────────────────────────┘
```

The bot process and WS worker both write to `alertQueue`; the alert worker exclusively reads from it. No direct cross-process calls.

---

## 4. Request Flow

```
Telegram update
  → POST /webhook/<token>  (Fastify)
  → handleWebhook()  (grammY webhookCallback)
  → authMiddleware  (loads ctx.user from DB by telegramId)
  → rateLimitMiddleware  (Redis INCR, 20 req/min)
  → command handler
```

`ctx.user` is `undefined` for new users; `/start` handles onboarding. All other handlers guard with `if (!ctx.user)`. Multi-step flows store transient state in Redis under `pending:<telegramId>` (10-minute TTL); a catch-all `bot.on("message:text")` handler dispatches based on this key.

---

## 5. Database Schema

### `users`
- `id` — telegram user ID (string PK)
- `telegramId` (unique), `username`, `firstName`
- `privyUserId`, `walletAddress` — Privy embedded wallet
- `phoenixActivated` — whether POST `/v1/invite/activate` succeeded
- `referralCode` — 8-char uppercase hex, bot-native
- `referredBy` — code used at signup

### `alert_subscriptions`
- `userId` (FK → users, cascade), `type` (pgEnum), `symbol` (nullable)
- `triggerPrice` — for price alerts only
- `enabled` boolean

Alert types: `at_risk`, `cancellable`, `liquidatable`, `fill`, `tpsl_flip`, `price`, `funding_flip`, `large_funding`

### `referrals`
- `referrerId`, `refereeId` (FKs → users, cascade)
- `tier` (pgEnum): `t1` | `t2`
- `accruedUsdc`, `claimedUsdc` — numeric(20,6); bot-funded rebate tracking

### `settings`
- `userId` (PK, FK → users, cascade)
- `slippageBps` (default 50 = 0.5%), `defaultLeverage` (default 5x)

---

## 6. Command Inventory (22 commands)

### Account
| Command | Description |
|---|---|
| `/start [code]` | Onboarding: jurisdiction attestation, Privy wallet creation, Phoenix activation, referral link. Also handles deep links from `/positions` (`pos_<symbol>_<side>`) and `/history` (`hist_<idx>_<page>`). |
| `/balance` | Deposited USDC, available margin, unrealized PnL, unsettled funding, SOL gas, risk tier |
| `/deposit` | QR code to embedded wallet address |
| `/withdraw [amount]` | Two-step with 5-minute security delay |
| `/export` | Private key export notice (Privy dashboard link) |

### Trading
| Command | Description |
|---|---|
| `/long [symbol] [lev] [size]` | Open long; guided flow or one-liner |
| `/short [symbol] [lev] [size]` | Open short |
| `/positions` | List open positions; deep-link to detail with close/margin/SL-TP actions |
| `/markets` | Browse all markets paginated (10/page) with price and funding APR |
| `/price <symbol>` | Mark price, funding APR, OI, fees, technical indicators, long/short actions |
| `/setsl <symbol>` | Set stop loss (presets −2% to −20%, custom, market/limit mode) |
| `/settp <symbol>` | Set take profit (presets +5% to +50%, custom, ladder exit) |

### History & Analytics
| Command | Description |
|---|---|
| `/history` | Paginated trade history (5/page, last 30 trades). Each row: size, fill price, trade value (opens) or realized PnL (closes). Deep-link per row to full detail + Solscan. |
| `/pnl` | Unrealized PnL + pending funding across all positions |
| `/portfolio` | Full account snapshot — balance + all open positions in one view |
| `/share <symbol>` | Generates PNG P&L card via satori/sharp |

### Referral
| Command | Description |
|---|---|
| `/referral` | T1/T2 counts, total accrued, claimable USDC, referral link |
| `/claim` | Claims accrued rebate (min $1) |

### Alerts
| Command | Description |
|---|---|
| `/alerts` | Toggle 7 alert types per-user (at-risk, cancellable, liquidatable, fill, TP/SL flip, funding flip, large funding) |
| `/alert <symbol>` | Set price alert; fires once when price crosses target |

### Settings & Info
| Command | Description |
|---|---|
| `/settings` | Slippage (0.1–2%) + default leverage (2x–50x) presets |
| `/funding` | Top 10 markets by funding rate magnitude with APR |

---

## 7. Phoenix Integration

### Clients (`src/services/phoenix/client.ts`)
Two singletons from `@ellipsis-labs/rise`:
- **Read client** — `getPhoenixClient()`: no exchange metadata stream
- **Trading client** — `getTradingClient()`: Flight routing enabled if `BUILDER_AUTHORITY_PUBKEY` is ≥43 chars

### Markets (`src/services/phoenix/market.ts`)
- `ISOLATED_ONLY_MARKETS`: `Set(['GOLD', 'SILVER', 'SKR', 'WTIOIL'])` — require isolated subaccount
- `getMarketSnapshot(symbol)` — 3 parallel calls: market config + mid price + funding rate
- `MarketSnapshot` type: markPrice, tickSize, baseLotsDecimals, maxLeverage, taker/makerFee, fundingRate, openInterest, isIsolatedOnly

### Positions (`src/services/phoenix/position.ts`)
- `getTraderState(walletAddress)` — REST → parses nested subaccounts response
  - Side derived from sign of `virtualQuotePosition`
  - markPrice derived from `positionValue / size`
- `getTradeHistory(walletAddress, limit)` — fills with realized P&L, cursor-based pagination
  - `TradeHistoryEntry` fields: `symbol`, `side`, `realizedPnl`, `price`, `size`, `fee?` (mapped defensively as `(r as any).fee`), `timestamp`, `signature`, `instructionType`
  - `instructionType === "ReduceOnly"` identifies closing trades; open trades may carry `"Market"` / `"Limit"` / `"PostOnly"` (detected by substring match in `history.ts`)

### Trades (`src/services/phoenix/trade.ts`)
- `placeMarketOrder()`, `placeLimitOrder()` — via `@ellipsis-labs/rise`
- `closePosition(symbol, wallet, signer, fraction)` — reduce-only IOC
- `setTpSl()`, `cancelStopLoss()` — risk management orders
- `addMargin()`, `depositCollateral()`, `withdrawCollateral()` — collateral management
- Internal: `sendInstruction()` / `sendInstructions()` serialize, sign, and broadcast; block hash is cached

### Key Phoenix Facts
- **Phoenix USDC** (`PhUsd...`) ≠ standard USDC (`EPjFWdd5...`); goes through **Ember proxy** (1:1 wrap)
- Account PDA: `(wallet_authority, portfolio_index, subaccount_index)` — `subaccount_index=0` = cross-margin
- Builder fees: 10–15 bps taker-only; user activation via `POST /v1/invite/activate`

---

## 8. Wallet & Signing

`src/services/wallet.ts`:
- **`createEmbeddedWallet(telegramUserId)`** — creates Privy user with Telegram linked account, returns Solana address
- **`getWalletSigner(walletAddress)`** — async signer via `privyClient.walletApi.solana.signTransaction()`
- **`getKitSigner(walletAddress)`** — **NOT IMPLEMENTED** for production; only `TEST_KEYPAIR` path works
- **`initTestSigner()`** — loads `TEST_KEYPAIR` env var as `KeyPairSigner` (dev/test only)

The Privy → `@solana/kit` `TransactionSigner` bridge (needed to pass a signer to the Rise SDK) is the primary production blocker. Without it, all on-chain transactions fail outside of test mode.

---

## 9. Referral System

Two-level, operator-funded rebate chain (independent of Phoenix's native referral program):

```
User A (referrer) ← T1 ← User B ← T1 ← User C
                           └── A is T2 referrer of C
```

- **`linkReferral(refereeId, code)`** — creates T1 row; if referrer also has a T1 parent, creates T2 row linking grandparent to new user
- **`accrueReferralFee(userId, notionalUsdc)`** — called on fill; builder fee = `notional × BUILDER_FEE_BPS / 10000`; T1 gets 20%, T2 gets 10%
- **`getReferralStats(userId)`** — T1 count, T2 count, total accrued, claimable (accrued − claimed)
- Claim threshold: $1 minimum; updates `claimedUsdc` (no on-chain transaction — internal accounting)

Known bug: `linkReferral` T2 lookup doesn't filter `eq(referrals.tier, "t1")`, so it can pick a T2 row as the parent reference, creating incorrect chains.

---

## 10. Alert & WebSocket Pipeline

### WS Worker (`src/workers/ws.ts`)

Per-user subscriptions to Phoenix `traderState` channel:
- **Position flip detection** — compares incoming position sides vs Redis-cached `ws:positions:<wallet>` (3600s TTL); queues `tpsl_flip` alert on side change
- **Risk alerts** — fires for `atRisk`, `cancellable`, `liquidatable` tiers
- **Fill alerts** — fires on new fills; triggers `accrueReferralFee()` asynchronously
- Reconnects on WebSocket close (5-second delay)

Single `allMids` subscription for price alert evaluation:
- On each price tick, fetches cached alert subscriptions (30s cache)
- Checks if price crossed `triggerPrice` threshold per subscription
- Dedup key: `alert:price:{userId}:{symbol}:{trigger}` (3600s TTL — fires once per hour max)

### Alert Worker (`src/jobs/processors/alert.ts`)

BullMQ consumer (concurrency 10):
1. Receives `AlertJobData` (telegramId, type, message, symbol?)
2. Checks dedup key `alert:dedup:{telegramId}:{type}:{symbol}` (NX, 5s EX)
3. Sends `bot.api.sendMessage()` with HTML parse mode
4. 3 retry attempts with exponential backoff

---

## 11. Image Generation

`src/services/image.ts`:
- Uses **satori** (JSX → SVG, no browser) + **sharp** (SVG → PNG Buffer)
- Output: 1200×630px dark slate card
- Content: symbol, side (LONG/SHORT badge), ROI%, P&L USDC, entry/exit prices, bot handle, funding APR if notable
- Font: Inter Bold loaded from disk at build time
- Returns `Buffer` for use with Telegram `InputFile`

---

## 12. Formatting Utilities (`src/bot/lib/fmt.ts`)

| Function | Output |
|---|---|
| `usd(n)` | `$1,234.56` |
| `price(n)` | Adaptive decimal places (2/4/6) by magnitude |
| `pct(n)` | `+1.23%` |
| `fundingApr(rate)` | `rate × 1095 × 100` % (3× daily annualized) |
| `fundingDir(rate)` | `"Longs pay shorts"` / `"Shorts pay longs"` |
| `cryptoSize(n, sym)` | `"0.0042 BTC"` |
| `shortAddr(addr)` | `"ABCD...WXYZ"` |
| `parseAmount(raw)` | Strips `$`, commas, spaces → float |
| `parseLeverage(raw)` | Strips `x`/`X` → float |
| `solscanUrl(sig)` | Solscan transaction link |

## 12a. Pagination Utility (`src/bot/lib/paginate.ts`)

Shared helper used wherever a command paginates a list (currently `/history`; designed for reuse in `/markets`, etc.).

| Export | Signature | Description |
|---|---|---|
| `paginate<T>` | `(all, page, pageSize) → Paginated<T>` | Slices an array for the requested page; clamps `page` to valid range; returns `{ items, page, totalPages, hasPrev, hasNext }` |
| `addPaginationRow` | `(kb, prefix, page, totalPages) → void` | Appends `← Prev · N/Total · Next →` buttons to an existing `InlineKeyboard`; no-op when `totalPages ≤ 1` |

Callback convention: `<prefix>:<page>` (e.g. `hist:list:0`). The `N/Total` centre button uses the `noop` callback.

---

## 13. Test Coverage

### Unit Tests
- `tests/unit/services/referral.test.ts` — `generateReferralCode()` format and uniqueness
- `tests/unit/services/market.test.ts` — `isIsolatedOnly()` correctness + case-insensitivity
- `tests/unit/services/image.test.ts` — `generatePnlCard()` returns Buffer for profit/loss

### Integration Tests
- `tests/integration/referral.test.ts` — full T1/T2 chain, self-referral prevention, depth cap
- `tests/integration/alerts.test.ts` — toggle targeting (only matched type affected), insert on missing

Test setup (`tests/setup.ts`) overrides env vars with safe test values. `vitest.config.ts` (unit) and `vitest.integration.config.ts` (integration, 30s timeout) are both present.

---

## 14. Known Bugs (from CLAUDE.md + code review)

| # | Location | Bug |
|---|---|---|
| 1 | `src/bot/commands/alerts.ts` | `findFirst` for alert toggle missing `type` filter — can toggle wrong alert |
| 2 | `src/bot/commands/deposit.ts`, `share.ts` | `replyWithPhoto` receives raw `Uint8Array`; needs `new InputFile(...)` wrapper |
| 3 | `src/bot/commands/long.ts`, `short.ts` | Confirm callback regex `(\d+)` rejects decimal sizes |
| 4 | `src/services/referral.ts` | T2 chain lookup missing `eq(referrals.tier, "t1")` filter — may pick T2 row as parent |
| 5 | `package.json` | `ws` and `@types/ws` missing; imported in `src/workers/ws.ts` |
| 6 | `src/services/wallet.ts` | Privy → `@solana/kit` signer bridge not implemented — all production transactions fail |
| 7 | Type system | `RiskTier` defines both `"at_risk"` and `"atRisk"` — inconsistent casing between WS messages and internal types |
| 8 | `src/bot/commands/history.ts` | `realizedPnl` in the list header always shows $0.00 if the Rise SDK does not populate that field for closing trades — needs verification against live API response |

---

## 15. Environment Variables

Required at startup (Zod crash on missing):

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot auth |
| `WEBHOOK_URL` | Production webhook URL (optional dev) |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Wallet custody |
| `BUILDER_AUTHORITY_PUBKEY` | Phoenix Flight routing |
| `BUILDER_ACCESS_CODE` | User activation |
| `BUILDER_FEE_BPS` | Builder fee (default 10) |
| `PHOENIX_API_URL` / `PHOENIX_WS_URL` | API endpoints |
| `HELIUS_RPC_URL` | Solana RPC |
| `DATABASE_URL` | PostgreSQL |
| `REDIS_URL` | Redis |
| `PORT` / `HOST` | Server binding (default 3000 / 0.0.0.0) |
| `TEST_KEYPAIR` | Dev/test only; bypasses Privy |

---

## 16. Architecture Strengths & Gaps

### Strengths
- **Clear process separation** — bot, WS worker, and alert worker are fully decoupled; each can scale or restart independently
- **Type-safe stack** — Zod env validation, Drizzle schema inference, strict TypeScript throughout
- **Deduplication at two layers** — NX Redis key in alert worker (5s window) + price-alert dedup (3600s)
- **Graceful multi-step UX** — Redis pending state enables natural conversation flows without maintaining in-memory bot state across restarts
- **Operator-funded rebates** — referral system doesn't depend on Phoenix's $10K volume threshold

### Gaps
- **Privy signer bridge missing** — `getKitSigner()` is a stub; no production trades possible from Telegram
- **Isolated margin not enforced** — GOLD/SILVER/SKR/WTIOIL show warnings but the bot doesn't switch to isolated subaccount before trading
- **No retry on WebSocket bootstrap failure** — if Phoenix WS is down at startup, user subscriptions are silently lost
- **No BullMQ draining on SIGTERM** — in-flight alerts may be dropped on deploy restart
- **Referral accrual not atomic** — fill event and `accrueReferralFee()` are separate; a crash between them loses the fee
- **`TEST_KEYPAIR` shortcut active in dev** — auth middleware bypasses Privy and auto-registers; easy to forget when testing onboarding flows
