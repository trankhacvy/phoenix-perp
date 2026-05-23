# PhoenixPerpBot — Deep Codebase Research Report

## 1. What This Project Is

PhoenixPerpBot is a **Telegram-native perpetual futures trading bot** built on top of [Phoenix](https://phoenix.trade), a CLOB-based perpetual DEX on Solana. It lets users open leveraged long/short positions, manage risk (TP/SL), monitor wallets, and earn referral rebates — all without leaving Telegram. No browser, no app download, no seed phrase management required.

The bot acts as a **Flight builder** — a third-party order router that wraps user orders through Phoenix's builder SDK, earning 10–15 bps taker fees on every fill.

**Current state:** MVP in active development. Core trading flows, alert pipeline, referral system, and safety hardening (BotError, preflight checks, lot helpers) are implemented. The Rise SDK (`@ellipsis-labs/rise@^0.4.9`) is installed and integrated.

---

## 2. Architecture

### 2.1 Process Model

Three independently deployed Railway services:

| Process | Entry | Purpose |
|---|---|---|
| **Bot** | `src/main.ts` | grammY Telegram bot + Fastify webhook server |
| **WS Worker** | `src/workers/ws.ts` | Phoenix WebSocket subscriptions for real-time events |
| **Alert Worker** | `src/workers/alert.ts` | BullMQ consumer that dispatches Telegram notifications |

They communicate exclusively through **BullMQ** (Redis-backed job queue) and **Redis pub/sub** — never direct function calls. This enables independent scaling and fault isolation.

### 2.2 Request Flow (Bot)

```
Telegram → POST /webhook/<token> (Fastify)
  → grammY webhookCallback
  → authMiddleware       — loads ctx.user from DB by telegramId
  → actionLogMiddleware  — records command, args, outcome, duration
  → rateLimitMiddleware  — Redis INCR, 20 req/min general + 5 orders/min
  → command handler
```

- `ctx.user` is `undefined` for unregistered users. Only `/start` handles onboarding; all other commands guard with `if (!ctx.user)`.
- Multi-step flows (e.g., "enter margin amount") use **Redis pending state**: key `pending:<telegramId>` stores `action:symbol`. A catch-all `bot.on("message:text")` handler in `src/bot/index.ts` dispatches based on this key.

### 2.3 Alert Pipeline

```
WS Worker detects event (position flip, fill, risk tier change, price cross)
  → alertQueue.add({ telegramId, type, message, symbol? })
  → Alert Worker picks up job
  → Dedup check: Redis SET NX with 5s TTL on key dedup:alert:<telegramId>:<type>[:<symbol>]
  → If not duped: bot.api.sendMessage(telegramId, message)
```

The WS worker (`src/workers/ws.ts`, 487 lines) is the most complex file in the codebase. It:
- Bootstraps by loading all users and their wallet monitors from the DB
- Subscribes to `traderState` events per wallet via Phoenix WebSocket
- Subscribes to `allMids` for price alert monitoring
- Tracks position state in-memory to detect flips (long→short, open→close)
- Monitors external wallets (wallet-monitor feature) for open/flip/close events
- Listens on Redis pub/sub channel `monitor:events` for dynamic subscription changes (new user registers, wallet monitor added/removed)

### 2.4 Data Flow Diagram

```
┌─────────────┐    webhook     ┌──────────┐
│  Telegram    │──────────────→│  Bot     │
│  (users)     │←──────────────│ (grammY) │
└─────────────┘    reply       └────┬─────┘
                                    │ queries/mutations
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              ┌──────────┐   ┌──────────┐    ┌──────────┐
              │PostgreSQL │   │  Redis   │    │ Phoenix  │
              │ (Drizzle) │   │ (ioredis)│    │ Rise SDK │
              └──────────┘   └────┬─────┘    └──────────┘
                                  │ BullMQ jobs
                    ┌─────────────┼─────────────┐
                    ▼                           ▼
              ┌──────────┐              ┌──────────────┐
              │WS Worker │              │Alert Worker  │
              │(Phoenix  │──alertQueue─→│(BullMQ       │
              │ WebSocket)│              │ consumer)    │
              └──────────┘              └──────────────┘
```

---

## 3. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript 5.7 (ESM, `"moduleResolution": "NodeNext"`) | All imports require `.js` extensions |
| Bot framework | grammY 1.31 + @grammyjs/parse-mode | Entities-based formatting, never raw HTML |
| HTTP server | Fastify 5.2 | Webhook endpoint + health check only |
| Blockchain | @solana/web3.js, @solana/kit, @ellipsis-labs/rise 0.4.9 | Rise SDK for Phoenix perp operations |
| Database | Drizzle ORM 0.38 + postgres.js | PostgreSQL, 6 tables |
| Job queue | BullMQ 5.34 | Redis-backed, alert dispatch |
| Cache/state | ioredis 5.4 | Pending state, rate limits, dedup, pub/sub |
| Auth | @privy-io/server-auth 1.20 | Embedded Solana wallets, no seed phrases |
| Image gen | satori + @resvg/resvg-js + sharp | PnL share card PNG generation |
| TA indicators | technicalindicators | RSI, MACD, Bollinger Bands, ATR |
| Validation | Zod | Config validation at startup |
| Linting | Biome 1.9.4 | Lint + format, 2-space indent, double quotes |
| Testing | Vitest 2.1 + @vitest/coverage-v8 | Unit + integration suites |
| CI/CD | GitHub Actions → Coolify webhooks | 3 separate service deployments |

---

## 4. Database Schema

Six tables defined in `src/db/schema/`:

### `users` (`users.ts`)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| telegramId | text, unique | Primary identity |
| username | text | Telegram username |
| firstName | text | |
| privyUserId | text | Privy embedded wallet link |
| walletAddress | text | Solana pubkey |
| phoenixActivated | boolean | Flight activation status |
| referralCode | text, unique | Bot-native 8-char hex |
| referredBy | text | Code used at signup |
| createdAt, updatedAt | timestamp | |

### `referrals` (`referrals.ts`)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| referrerId, refereeId | FK → users | |
| tier | pgEnum `t1` / `t2` | Two-level chain |
| accruedUsdc | numeric(20,6) | Pending rewards |
| claimedUsdc | numeric(20,6) | Already claimed |

### `alert_subscriptions` (`alerts.ts`)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| userId | FK → users | |
| type | pgEnum | 8 types: at_risk, cancellable, liquidatable, fill, tpsl_flip, price, funding_flip, large_funding |
| symbol | text, nullable | null = all markets |
| triggerPrice | numeric, nullable | Price alerts only |
| enabled | boolean | |

### `user_settings` (`settings.ts`)
| Column | Type | Default |
|---|---|---|
| userId | PK, FK → users | |
| slippageBps | integer | 50 (0.5%) |
| defaultLeverage | integer | 5 |

### `wallet_monitors` (`wallet_monitors.ts`)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| userId | FK → users | |
| watchedWallet | text | Solana address to watch |
| label | text | User-friendly name |
| alertOnFill, alertOnPositionChange | boolean | Toggle per event type |
| enabled | boolean | |
| Unique constraint on (userId, watchedWallet) | | Max 10 per user |

### `action_logs` (`action_logs.ts`)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| userId | FK → users | |
| command | text | Command name |
| args | jsonb | Redacted arguments |
| outcome | pgEnum `success` / `error` | |
| errorCode, errorCategory | text | BotError classification |
| durationMs | integer | |
| txSignature | text | Solana tx sig if applicable |
| 30-day retention | | Cleaned up at bot startup |

---

## 5. Bot Commands and Features

### 5.1 Command Catalog

**Onboarding:**
- `/start [referralCode]` — Jurisdiction attestation → Privy wallet creation → Phoenix activation → referral linking

**Trading:**
- `/long [symbol]` — Open long: symbol picker → leverage picker (2–50x) → size picker (preset % or custom USDC) → preflight check → confirmation → execute
- `/short [symbol]` — Mirror of `/long` for shorts
- `/positions` — List open positions with total uPnL; detail view per position with close (25/50/100%), add margin, set SL/TP
- `/setsl <symbol>` — Set stop-loss with preset percentages or custom price
- `/settp <symbol>` — Set take-profit; supports ladder exits (25/50/100% at different levels)

**Portfolio:**
- `/portfolio` — Account overview: collateral, open PnL, position list, risk tier
- `/wallet [address]` — Analytics for any wallet: volume, win rate, best/worst trades, per-market breakdown
- `/history` — Paginated trade history (5/page) with detail view and Solscan links
- `/markets` — Paginated market list with detail pages showing funding, OI, TA indicators

**Money:**
- `/deposit` — Shows wallet address + QR code for USDC deposits
- `/withdraw [amount]` — Multi-step withdrawal with 5-minute security delay
- `/funding` — Top 10 funding rates with APR and direction

**Referral:**
- `/referral` — Show referral code, T1/T2 counts, accrued/claimable USDC
- `/claim` — Claim referral rebates ($1 minimum)

**Alerts:**
- `/alerts` — Toggle 8 alert types per-user
- `/alert <symbol>` — Set price alert above/below current market
- `/walletmonitor` — Monitor up to 10 external wallets for trade activity

**Settings:**
- `/settings` — Slippage (0.1–2.0%) and default leverage (2–50x)
- `/export` — Instructions for Privy private key export
- `/share <symbol>` — Generate and send PnL card image

**Admin:**
- `/log` — Last 10 action logs (admin only)

### 5.2 UI Patterns

- **Picker → Confirm → Execute** flow for all trades
- **Inline keyboards** for leverage (2x, 5x, 10x, 25x, 50x + custom), size (10/25/50/100% + custom), and position actions
- **Pagination** via `src/bot/lib/paginate.ts` with prev/next callback buttons
- **Pending state** in Redis for multi-step text input (10-min TTL)
- **Callback query routing** in `src/bot/index.ts` for interactive button presses
- **Navigation callbacks** (balance, deposit, withdraw, positions, history, long, short, alerts, cancel) registered in command index

### 5.3 Message Formatting

Strict use of `@grammyjs/parse-mode`:
- `fmt` tagged template for composition
- `FormattedString.b()`, `.i()`, `.code()`, `.link()` for inline formatting
- Always `{ entities: msg.entities }`, never `{ parse_mode: "HTML" }`
- `FormattedString.join(arr, separator)` for lists
- `link_preview_options: { is_disabled: true }` when URLs present

Number formatting helpers in `src/bot/lib/fmt.ts`: `usd()`, `price()`, `pct()`, `signedUsd()`, `fundingApr()`, `cryptoSize()`, `shortAddr()`, `timeAgo()`, `compactUsd()`.

---

## 6. Phoenix Integration Details

### 6.1 SDK and Client (`src/services/phoenix/client.ts`)

- **Read client** (`getPhoenixClient()`) — for market data, positions, history queries
- **Trading client** (`getTradingClient()`) — includes builder authority for Flight fee routing
- Singleton pattern; validates builder authority as 43+ char base58

### 6.2 Markets (`src/services/phoenix/market.ts`)

- `getMarkets()` — All markets with 60-second in-memory cache
- `getMarketSnapshot()` — Aggregates price, fees, funding, leverage tiers
- `getOrderbook()` — Current bid/ask/mid
- **Isolated-only markets**: `GOLD`, `SILVER`, `SKR`, `WTIOIL` — require isolated subaccount (subaccount_index > 0)
- Regular markets use cross-margin (subaccount_index = 0)

### 6.3 Trade Execution (`src/services/phoenix/trade.ts`)

- `placeMarketOrder()` — Immediate fill via Flight
- `placeLimitOrder()` — Limit orders with custom price
- `closePosition()` — Full or fractional close
- `setTpSl()` — Single or ladder (25/50/100%) take-profit and stop-loss
- `cancelStopLoss()` — Remove TP/SL orders
- `addMargin()` / `depositCollateral()` / `withdrawCollateral()` — Collateral management

Internals:
- RPC client with WebSocket subscriptions
- Blockhash caching with 20-second TTL
- Transaction building via `@solana/kit`
- Price/quantity conversion utilities for lot sizing

### 6.4 Preflight Validation (`src/services/phoenix/preflight.ts`)

`preflightOpen()` performs 9 checks before any order:
1. Phoenix account activation
2. Market existence
3. Mark price availability
4. Isolated-only market detection
5. Margin/leverage validity (finite, positive)
6. Collateral sufficiency (margin + estimated fee)
7. Leverage tier cap (per-market, size-based)
8. Notional within tier limit
9. Price drift detection (slippage tolerance, default 50 bps)

Returns: effective leverage, notional, fee estimate, liquidation price, and full market snapshot.

### 6.5 Lot Sizing (`src/services/phoenix/lots.ts`)

- `marginToTokens(margin, leverage, snapshot)` — Converts USDC margin to base token quantity; rounds down to lot precision to prevent overshoot
- `fractionToCloseLots(fraction, positionLots, snapshot)` — Converts "close 50%" to absolute lot count
- `baseLotsToTokens(lots, snapshot)` — Reverse conversion

### 6.6 Technical Analysis (`src/services/phoenix/candles.ts`)

- `getCandles(symbol, timeframe, limit)` — OHLCV from Phoenix API
- `getTaSnapshot(symbol)` — RSI, MACD, Bollinger Bands, ATR from 60 hourly candles

### 6.7 Wallet Analytics (`src/services/phoenix/position.ts`)

- `getTraderState()` — Aggregates positions across cross + isolated subaccounts with risk metrics
- `computeWalletAnalytics()` — Total fills, volume, realized PnL, win rate, per-market breakdown, best/worst trades

### 6.8 Key Phoenix Concepts

- **Phoenix USDC** (`PhUsd...`) ≠ standard USDC (`EPjFWdd5...`). The **Ember proxy contract** wraps 1:1. All deposits go through Ember wrap; withdrawals through Ember unwrap.
- **Account PDA**: `(wallet_authority, portfolio_index, subaccount_index)`. Index 0 = cross-margin, >0 = isolated.
- **Flight builder fees**: 10–15 bps taker-only. Builder activates users via `POST /v1/invite/activate` with `BUILDER_ACCESS_CODE`.
- **Leverage tiers**: Market-specific, size-dependent. Formula: `initial_margin = position_notional / max_leverage`. Queried dynamically.
- **Risk tiers**: safe → healthy → atRisk → cancellable → liquidatable → backstopLiquidatable → highRisk

---

## 7. Wallet and Identity

- **Privy** creates a server-side embedded Solana wallet per user (`src/services/wallet.ts`)
- `telegramId` (string) is the primary identity — used as Privy linked account identifier and users table key
- `createEmbeddedWallet()` — Links Telegram ID to Privy, returns wallet address
- `getWalletSigner()` — Returns async signer function via Privy wallet API for transaction signing
- `getKitSigner()` — Returns `@solana/kit` compatible signer (currently requires test signer or has TODO)
- `activatePhoenixAccount()` — POST to Flight API with builder access code
- Users can export their private key via Privy dashboard (instructions in `/export` command)

---

## 8. Referral System

### Bot-Native (implemented)

Independent of Phoenix's native referral program (which requires $10K volume):

- **T1**: Direct referral. Referrer gets 20% of builder fee on referee's trades.
- **T2**: Referrer's referrer. Gets 10% of builder fee.
- Operator-funded from builder fee margin.
- Rewards accrue in USDC, claimable with $1 minimum via `/claim`.
- Code: 8-character uppercase hex, generated at onboarding.
- Linking: `/start <code>` creates T1 row; if referrer themselves was referred, creates T2 row too.

### Phoenix Native (documented, not directly used)

- 20% T1, 10% T2 fee sharing
- 10% trading fee discount for referred users
- $10K lifetime volume required to generate a code

---

## 9. Error Handling

### BotError System (`src/bot/lib/errors.ts`)

Custom `BotError` class with structured fields:
- **category** (16 types): validation, auth, config, api, network, ratelimit, tx_failed, io, gate, internal, etc.
- **code** (18 codes): INSUFFICIENT_MARGIN, PRICE_DRIFT, UNKNOWN_MARKET, ISOLATED_ONLY_MARKET, SIZE_TOO_SMALL, LEV_OUT_OF_RANGE, NOT_REGISTERED, INSUFFICIENT_SOL, RATE_LIMIT, etc.
- **retryable**: boolean flag
- **userMessage**: human-friendly text for Telegram
- **hint**: optional guidance for the user

`toBotError()` converts raw SDK/network errors into BotError via regex pattern matching. `renderBotError()` formats for Telegram display with retry hints.

### Action Logging (`src/services/action-log.ts`, `src/bot/middleware/action-log.ts`)

Every user action is logged with:
- Command name and redacted arguments (strips password, privateKey, apiKey, secret, token, mnemonic, seed)
- Outcome (success/error), error code/category
- Duration in ms
- Transaction signature if applicable
- 30-day retention (cleanup at bot startup)

### Rate Limiting (`src/bot/middleware/rate-limit.ts`)

Two tiers:
- **General**: 20 requests per 60 seconds
- **Orders**: 5 order submissions per 60 seconds

---

## 10. Testing

### Unit Tests (7 files in `tests/unit/`)

| File | What it tests |
|---|---|
| `errors.test.ts` | BotError construction, `toBotError` SDK error classification (blockhash, SOL, margin, slippage, rate limit, network) |
| `action-log.test.ts` | `redactArgs` — sensitive key scrubbing, nested objects, type serialization |
| `image.test.ts` | `generatePnlCard` — profit and loss card PNG buffer generation |
| `lots.test.ts` | `marginToTokens`, `fractionToCloseLots`, `baseLotsToTokens` — precision, edge cases, error codes |
| `market.test.ts` | `isIsolatedOnly` — GOLD/SILVER/SKR/WTIOIL = true, SOL/BTC/ETH = false |
| `preflight.test.ts` | `preflightOpen` — 9 validation checks with mocked market/position data |
| `referral.test.ts` | `generateReferralCode` — format validation, uniqueness over 100 generations |

### Integration Tests (2 files in `tests/integration/`)

| File | What it tests |
|---|---|
| `alerts.test.ts` | Alert subscription toggling, new row insertion, multi-type isolation |
| `referral.test.ts` | T1/T2 linking, stats aggregation, self-referral prevention, T3 chain prevention |

### Test Infrastructure

- `vitest.config.ts` — Node environment, v8 coverage, excludes integration tests by default
- `vitest.integration.config.ts` — 30-second timeout, integration tests only
- `tests/setup.ts` — Mocks env vars (bot token, Privy, builder keys, DB, Redis)

---

## 11. CI/CD Pipeline

`.github/workflows/ci.yml`:

**CI job** (push to main/develop, PRs to main):
- Services: PostgreSQL 16 + Redis 7
- Steps: checkout → pnpm install → `pnpm check` (biome) → `pnpm build` (tsc) → `pnpm test` (vitest with coverage)

**Deploy job** (push to main, after CI passes):
- Deploys 3 services to **Coolify** via webhook triggers:
  - `bot` — Telegram bot + webhook server
  - `ws-worker` — Phoenix WebSocket subscriptions
  - `alert-worker` — BullMQ alert processor

---

## 12. Configuration

All env vars validated at startup via Zod (`src/config/index.ts`). Crashes with field-level errors on failure.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot API token |
| `WEBHOOK_URL` | No | — | Production webhook URL (omit for long-polling) |
| `PRIVY_APP_ID` | Yes | — | Privy auth |
| `PRIVY_APP_SECRET` | Yes | — | Privy auth |
| `BUILDER_AUTHORITY_PUBKEY` | Yes | — | Flight builder Solana wallet |
| `BUILDER_ACCESS_CODE` | Yes | — | User activation code |
| `BUILDER_FEE_BPS` | No | 10 | Builder fee (1–50 bps) |
| `PHOENIX_API_URL` | No | `https://perp-api.phoenix.trade` | REST API |
| `PHOENIX_WS_URL` | No | `wss://perp-api.phoenix.trade/v1/ws` | WebSocket |
| `HELIUS_RPC_URL` | Yes | — | Solana RPC |
| `DATABASE_URL` | Yes | — | PostgreSQL |
| `REDIS_URL` | Yes | — | Redis |
| `PORT` | No | 3000 | Fastify server port |
| `HOST` | No | 0.0.0.0 | Fastify bind address |

---

## 13. Known Bugs and Technical Debt

From CLAUDE.md and code inspection:

1. **Alert toggle missing type filter** (`src/bot/commands/alerts.ts`) — `findFirst` query doesn't filter by `type`, so it may toggle the wrong subscription.

2. **replyWithPhoto gets raw Uint8Array** (`deposit.ts`, `share.ts`) — Needs `new InputFile(buffer)` wrapping for grammY.

3. **Confirm callback regex rejects decimals** (`long.ts`, `short.ts`) — Pattern `(\d+)` won't match decimal sizes like `12.5`.

4. **T2 chain lookup bug** (`src/services/referral.ts`) — Can pick a T2 row as the parent when linking T2 referrals. Needs `eq(referrals.tier, "t1")` filter.

5. **Missing `ws` / `@types/ws` in package.json** — Imported in `src/workers/ws.ts` but not declared as dependency. (May work via transitive dep.)

6. **vitest.config.ts** — Listed as missing in CLAUDE.md but actually exists now (added in recent commits).

7. **settings.ts schema** — Listed as missing in CLAUDE.md but actually exists at `src/db/schema/settings.ts` now (added in recent commits).

---

## 14. File Map

```
src/
├── main.ts                          # Entry: DB init, bot start (webhook or long-poll)
├── config/index.ts                  # Zod env validation
├── bot/
│   ├── index.ts                     # Bot instance, middleware stack, webhookCallback
│   ├── commands/
│   │   ├── index.ts                 # Command registration + nav callbacks
│   │   ├── start.ts                 # Onboarding flow
│   │   ├── long.ts                  # Open long position
│   │   ├── short.ts                 # Open short position
│   │   ├── positions.ts             # View/manage positions
│   │   ├── portfolio.ts             # Account overview
│   │   ├── wallet.ts                # Wallet analytics
│   │   ├── markets.ts               # Market browser
│   │   ├── history.ts               # Trade history
│   │   ├── deposit.ts               # Deposit QR + address
│   │   ├── withdraw.ts              # Multi-step withdrawal
│   │   ├── setsl.ts                 # Set stop-loss
│   │   ├── settp.ts                 # Set take-profit
│   │   ├── alerts.ts                # Toggle alert types
│   │   ├── pricealert.ts            # Price alert setup
│   │   ├── wallet-monitor.ts        # External wallet monitoring
│   │   ├── funding.ts               # Funding rate leaderboard
│   │   ├── referral.ts              # Referral dashboard
│   │   ├── claim.ts                 # Claim referral rebates
│   │   ├── settings.ts              # User preferences
│   │   ├── share.ts                 # PnL card image
│   │   ├── export.ts                # Private key export instructions
│   │   └── log.ts                   # Admin action log viewer
│   ├── keyboards/
│   │   ├── trade.ts                 # Leverage/size/confirm keyboards
│   │   ├── position.ts              # Position action keyboards
│   │   └── market.ts                # Market detail keyboards
│   ├── middleware/
│   │   ├── auth.ts                  # User loading from DB
│   │   ├── action-log.ts            # Action tracking
│   │   └── rate-limit.ts            # Redis-based rate limiting
│   └── lib/
│       ├── errors.ts                # BotError class, toBotError, renderBotError
│       ├── fmt.ts                   # Number/price/time formatting
│       ├── paginate.ts              # Pagination logic + keyboard buttons
│       ├── pending.ts               # Redis pending state (10-min TTL)
│       └── validate.ts              # BASE58 regex
├── services/
│   ├── wallet.ts                    # Privy embedded wallet management
│   ├── referral.ts                  # T1/T2 referral linking and accrual
│   ├── image.ts                     # PnL card PNG generation (satori + resvg)
│   ├── action-log.ts                # Action logging with sensitive data redaction
│   └── phoenix/
│       ├── client.ts                # Rise SDK client singleton
│       ├── market.ts                # Market data, leverage tiers, isolated-only list
│       ├── trade.ts                 # Order placement, TP/SL, close, collateral mgmt
│       ├── position.ts              # Positions, trade history, wallet analytics
│       ├── preflight.ts             # 9-point pre-order validation
│       ├── lots.ts                  # Margin↔token lot conversion
│       └── candles.ts               # OHLCV data + TA indicators
├── workers/
│   ├── ws.ts                        # Phoenix WebSocket worker (487 lines)
│   └── alert.ts                     # BullMQ alert processor
├── jobs/
│   ├── queues.ts                    # BullMQ alertQueue definition
│   └── processors/alert.ts          # Alert job handler with dedup
├── server/
│   ├── index.ts                     # Fastify setup (CORS, health, webhook)
│   └── routes/health.ts             # GET /health
├── db/
│   ├── index.ts                     # Drizzle ORM connection
│   ├── schema/                      # 6 table schemas
│   │   ├── users.ts
│   │   ├── referrals.ts
│   │   ├── alerts.ts
│   │   ├── settings.ts
│   │   ├── wallet_monitors.ts
│   │   ├── action_logs.ts
│   │   └── index.ts                 # Re-exports
│   └── migrations/                  # SQL migration files
├── lib/
│   ├── redis.ts                     # ioredis singleton
│   ├── logger.ts                    # Pino logger (debug in dev, info in prod)
│   ├── privy.ts                     # Privy client singleton
│   ├── retry.ts                     # withRetry() — exponential backoff
│   └── constants.ts                 # MONITOR_EVENTS_CHANNEL
└── types/index.ts                   # BotContext, RiskTier, TraderStateEvent, etc.

tests/
├── setup.ts                         # Env mocks
├── unit/
│   ├── lib/errors.test.ts
│   └── services/
│       ├── action-log.test.ts
│       ├── image.test.ts
│       ├── lots.test.ts
│       ├── market.test.ts
│       ├── preflight.test.ts
│       └── referral.test.ts
└── integration/
    ├── alerts.test.ts
    └── referral.test.ts

docs/                                # 30+ Phoenix protocol documentation files
scripts/                             # Utility scripts (register user, setup DB, test bot)
assets/fonts/Inter-Bold.ttf          # Font for PnL card generation
```

---

## 15. Key Design Decisions and Rationale

1. **Three-process split** — Bot, WS worker, and alert worker run independently so a WebSocket reconnect or alert backlog doesn't freeze the bot's Telegram responsiveness. Each can scale independently on Railway/Coolify.

2. **Redis as the central nervous system** — Pending state, rate limits, dedup, BullMQ, pub/sub for subscription changes. Single Redis instance ties everything together without direct process coupling.

3. **Privy embedded wallets** — Users never see a seed phrase. Privy holds the key material server-side and signs transactions via API. Users can export keys if they want via the Privy dashboard.

4. **Bot-native referral system** — Phoenix's native referral requires $10K volume which is too high for onboarding. The bot runs its own T1/T2 system funded from builder fee margin.

5. **Flight builder model** — Instead of just being a frontend, the bot wraps orders through Phoenix's Flight SDK, earning 10–15 bps on every taker fill. This is the business model.

6. **Entities-based formatting** — Using `@grammyjs/parse-mode` with entities instead of HTML parse mode. More reliable, no escaping issues, composable with `fmt` tagged templates.

7. **Preflight validation** — 9 checks before any order prevents wasted gas and bad UX from failed transactions. Catches everything from unactivated accounts to price drift.

8. **Action logging with redaction** — Every command is logged for debugging/analytics, but sensitive data (keys, secrets, mnemonics) is automatically scrubbed before storage.

---

## 16. Business Model

- **Revenue**: Builder fee of 10–15 bps on every taker fill routed through Flight
- **Cost structure**: Referral rebates (20% T1 + 10% T2 = up to 30% of builder fee given back), plus infrastructure (Railway/Coolify, PostgreSQL, Redis)
- **Target metrics** (90-day post-launch): 200 DAU, $500K daily volume, $3–5K monthly builder fee revenue
- **Stretch goals**: 500 DAU, $2M daily volume, $15K monthly revenue
