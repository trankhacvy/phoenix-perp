# Research: Phoenix Perp Monorepo — Deep Dive

**Date:** May 2026  
**Status:** Complete

---

## 1. What This Repo Is

Two independent products sharing a single repo:

1. **PhoenixPerpBot** — Telegram trading bot (TypeScript, Node.js)
2. **Vulcan CLI** — AI-native CLI + MCP server (Rust)

Both trade perpetual futures on [Phoenix Protocol](https://phoenix.trade) — an onchain CLOB-based perp DEX on Solana, built by Ellipsis Labs. The bot is custodial (Privy embedded wallets). Vulcan is self-custodial (local encrypted keypair).

---

## 2. Phoenix Protocol — What It Is

- Fully onchain CLOB perp DEX on Solana (FIFO matching)
- 29+ markets including crypto (SOL, BTC, ETH), commodities (GOLD, SILVER, OIL), and FX
- Base fees: 3.5 bps taker / 0.5 bps maker — cheapest in Solana ecosystem
- **Flight**: builder-routing layer where builders earn USDC fees (10–15 bps taker) on all orders they route
- Accounts: PDA derived from `(wallet_authority, portfolio_index, subaccount_index)`. Index 0 = cross-margin; >0 = isolated
- Collateral token: **PhoenixUSDC** (`PhUsd...`) — distinct from standard USDC (`EPjFWdd5...`). Conversion via Ember proxy contract 1:1
- Isolated-only markets: GOLD, SILVER, SKR, WTIOIL — require a dedicated isolated subaccount, not cross-margin
- **Rise SDK** is the developer SDK (TypeScript + Rust). Both products use it. Flight is currently beta.
- Leverage tiers: market-specific maximums, dynamic caps based on notional size
- Funding: 3x per day schedule (every 8 hours)
- Liquidations use maintenance margin ratio; risk tiers = `safe → atRisk → cancellable → liquidatable → backstopLiquidatable → highRisk`

---

## 3. PhoenixPerpBot — Architecture

### 3.1 Process Model

Three independently deployable services (Railway):

| Process | Entry | Role |
|---------|-------|------|
| Bot | `src/main.ts` | grammY bot + Fastify webhook server |
| WS Worker | `src/workers/ws.ts` | Phoenix WS subscriptions, risk/fill detection, price alerts |
| Alert Worker | `src/workers/alert.ts` | BullMQ consumer, Telegram message dispatch |
| Leaderboard Worker | `src/workers/leaderboard.ts` | GPA scan + REST hydration, periodic index rebuild |

The WS worker writes jobs to BullMQ. The alert worker consumes them. They never call each other directly. The leaderboard worker is independent.

### 3.2 Bot Request Flow

```
Telegram → POST /webhook/<token>  (Fastify)
  → handleWebhook (grammY webhookCallback)
  → authMiddleware  (loads ctx.user from DB by telegramId)
  → actionLogMiddleware  (derives command/args, wraps next() for timing/outcome)
  → rateLimitMiddleware  (Redis INCR, 20 req/min general, 5 orders/min)
  → command handler
```

`ctx.user` is `undefined` for new users — `start.ts` handles onboarding. All other commands guard with `if (!ctx.user)`.

Multi-step flows use Redis pending state: `pending:<telegramId>` → action string. A free-text `bot.on("message:text")` handler in `src/bot/index.ts` dispatches based on this key. Pending state TTL: 600 seconds.

### 3.3 Wallet & Identity

- **Privy** creates a server-side embedded Solana wallet per user (`src/services/wallet.ts`)
- `telegramId` (string) is the primary key in `users` table and Privy linked account identifier
- Private key derivation from Privy authorization key: strips `"wallet-auth:"` / `"wallet-api:"` prefix, decodes base64, uses as PKCS8 key to derive public key
- Dev mode: `TEST_KEYPAIR` env var loads a local keypair instead of Privy
- Transaction signing: `getPrivyKitSigner()` returns a KMS-backed signer; `getKitSigner()` for dev

### 3.4 Deposit / Withdraw Flow

**Deposit (2 steps):**
1. User clicks Deposit → bot shows wallet address + QR code (wallet USDC address)
2. User sends USDC to that address; bot detects idle USDC ≥ $1 and shows "Add Collateral" CTA
3. User confirms → bot calls `depositCollateral()` (via Ember proxy contract)

**Withdraw (security delay):**
1. User requests withdraw amount
2. Redis sets 5-minute timer key (`withdraw:security:<telegramId>`)
3. Only after 5 minutes can the on-chain transaction be submitted
4. `withdrawCollateral()` via Ember proxy contract

### 3.5 Trade Flow (Long/Short)

```
/long → symbol picker → leverage picker (with funding rate warning if APR > 10%)
  → size picker (% of available margin: 10/25/50/100%)
  → confirm screen (shows entry price, liq price, fees, daily funding cost)
  → preflightOpen() validation
  → placeMarketOrder() or placeLimitOrder()
  → transaction submitted, signature reported
```

Preflight checks: collateral available, leverage within tier cap, slippage drift, isolated account setup for isolated-only markets.

Action logging via `trackAction()` captures timing, outcome, tx signature.

### 3.6 Alert Pipeline

```
WS worker detects event → alertQueue.add(job)
Alert worker → dedup via Redis NX (5s window) → bot.api.sendMessage
```

Alert types (pgEnum): `fill`, `at_risk`, `cancellable`, `liquidatable`, `tpsl_flip`, `funding_flip`, `large_funding`, `price`.

Dedup key: `alert:dedup:<telegramId>:<type>:<symbol>` — prevents duplicate alerts within 5 seconds.

WS worker also handles:
- Position flip detection (side change alert + TP/SL invalidation)
- Risk tier transitions → pushes risk alerts
- Fill events → referral fee accrual + fill notification
- Monitored wallet tracking (copy-watch for external wallets)
- Price alert subscriptions via `allMids` WS channel

### 3.7 Leaderboard

- **GPA scan** (`getProgramAccounts`) discovers all trader PDAs using discriminant `[41,97,73,105,110,214,112,9]` (SHA-256 of `"account:trader"` first 8 bytes) and authority extraction at byte offset 56
- Hydrates each wallet via Phoenix REST API (trader state + trade history)
- Upserts into `leaderboard_snapshots` table
- Sorted by: `portfolio_value`, `realized_pnl`, `total_volume`
- Full scan: every 30 min; history hydration: every 2 hours
- WS trade listener per market adds newly discovered wallets in near-real-time

### 3.8 Referral System

Bot-native T1/T2 chain (independent of Phoenix's native referral program):

- Each user gets an 8-char hex code on signup (`generateReferralCode()`)
- On signup with referral code: creates T1 row (referrer→referee)
- If referrer was themselves referred: creates T2 row (grandparent→referee)
- **Fee accrual**: on every fill, T1 gets 20% of builder fee, T2 gets 10%
- Accrued as `accrued_usdc` in `referrals` table; claimable via `/claim` (min $1)
- Claim transfers from `accrued_usdc` to `claimed_usdc` in DB (actual USDC transfer is operator-funded)

---

## 4. DB Schema (Drizzle ORM + postgres.js)

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `users` | `telegram_id` PK, `wallet_address`, `privy_wallet_id`, `phoenix_activated`, `referral_code` | telegramId is PK and Privy identifier |
| `alert_subscriptions` | `user_id` FK, `type` (enum), `symbol` (nullable), `trigger_price`, `enabled` | symbol=null means all markets |
| `referrals` | `referrer_id`, `referee_id`, `tier` (t1/t2), `accrued_usdc`, `claimed_usdc` | bot-native chain, not Phoenix native |
| `user_settings` | `user_id` PK, `slippage_bps` (default 50), `default_leverage` (default 5) | upsert on update |
| `wallet_monitors` | `user_id`, `watched_wallet`, `label`, `alert_on_fill`, `alert_on_position_change`, `enabled` | max 10 per user |
| `leaderboard_snapshots` | `wallet_address`, `collateral_balance`, `unrealized_pnl`, `portfolio_value`, `realized_pnl`, `win_count`, `loss_count`, `total_volume`, `risk_tier` | indexed on portfolio_value, realized_pnl, updated_at |
| `action_logs` | `user_id`, `command`, `args` (JSONB), `outcome`, `error_code`, `duration_ms`, `tx_signature` | 30-day retention; composite indexes on (userId, createdAt) and (command, createdAt) |

Migrations: 5 files in `src/db/migrations/`. Drizzle Studio available via `pnpm db:studio`.

---

## 5. Message Formatting

All bot messages use `@grammyjs/parse-mode`:

```typescript
const msg = fmt`${bold("SOL · LONG")}  (Cross)
Entry  ${bold("$87.00")}`;
await ctx.reply(msg.text, { entities: msg.entities });
```

Never raw HTML strings or `parse_mode: "HTML"`. Entity offsets computed automatically by `fmt` tagged template. `link_preview_options: { is_disabled: true }` on all messages with URLs.

---

## 6. Vulcan CLI — Architecture

### 6.1 Purpose

Rust CLI + MCP server for algorithmic and AI-agent trading on Phoenix perps. Self-custodial (local encrypted keypair). Agent-first with every command dual-mode: human CLI + MCP tool call.

### 6.2 Crate Structure

```
vulcan/           # Binary crate: clap parsing, command dispatch
vulcan-lib/       # Library crate: all business logic
  cli/            # Clap derive structs (arg shapes only)
  commands/       # Execution handlers
  output/         # JSON envelope + table formatting
  mcp/            # MCP server, tool registry, session wallet
  wallet/         # AES-256-GCM encrypted keypair storage
  config/         # ~/.vulcan/config.toml
  context.rs      # AppContext (shared config, HTTP clients, wallet)
  error.rs        # VulcanError with category + exit code
  strategy/       # TWAP, Grid, TA runners + ledger persistence
  indicators/     # kand wrapper (RSI, MACD, BB, ATR, ADX, Stoch, VWAP)
  paper.rs        # Paper trading engine
  watch.rs        # WS streaming
  auth.rs         # Phoenix API session login
```

### 6.3 Command Taxonomy

| Group | Key Commands |
|-------|-------------|
| `market` | list, ticker, info, orderbook, candles |
| `trade` | market_buy/sell, limit_buy/sell, cancel, set_tpsl, cancel_tpsl, multi_limit |
| `position` | list, show, close, reduce, close_all, tp_sl |
| `margin` | status, deposit, withdraw, transfer, add_collateral, leverage_tiers |
| `account` | register, info, subaccounts, create_subaccount |
| `portfolio` | unified snapshot (cross + isolated + positions + orders) |
| `paper` | init, reset, status, buy/sell, set_tpsl, reconcile |
| `strategy` | twap start/resume, grid start/resume, ta start/resume, monitor, wait_next_tick, pause, stop, report |
| `wallet` | create, import, export, list, select, set-default |
| `auth` | login (wallet-signed session), status, logout |
| `history` | trades, orders, collateral flows, funding, pnl |
| `ta` | compute, signal, report |
| `status` | full system health check |

### 6.4 Strategy Engine

Three automated runners with persistent ledgers:

**TWAP** — splits large order into N slices at fixed intervals. Config: `symbol`, `side`, `notional_usdc`, `slices`, `interval_seconds`. Output: VWAP, per-slice signatures, fill prices.

**Grid** — layered limit orders across a price range. Buys lower, sells upper. Supports per-level TP/SL. Config: `lower_price`, `upper_price`, `levels_per_side`, `tokens_per_level`, `interval_seconds`. Reconciliation by order ID.

**TA (Technical Analysis)** — rule-based runner. Indicators: SMA, EMA, RSI, MACD, Bollinger Bands, ATR, VWAP, ADX, Stochastic. Triggers: cross, gt, lt, gte, lte. Example: `EMA(9) cross EMA(21)`.

Execution modes: `paper`, `dry_run`, `confirm_each`, `auto_execute` (requires `acknowledged: true` and `--allow-dangerous`).

Each run: unique `run_id`, persisted ledger in `~/.vulcan/strategy-runs/<run_id>/`, structured tick logs, final report.

### 6.5 MCP Server

```
vulcan mcp [--allow-dangerous]
```

Exposes all CLI commands as MCP tools (`vulcan_<group>_<action>`). Tool catalog generated at build time from `ToolDef` structs via schemars. Stored in `agents/tool-catalog.json`.

Session wallet: loaded once at startup from `VULCAN_WALLET_NAME` + `VULCAN_WALLET_PASSWORD` env vars. No per-call password prompts.

Dangerous tools hidden unless `--allow-dangerous` AND `acknowledged: true` on each call.

MCP integrations: `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`.

### 6.6 Wallet Management

- AES-256-GCM encryption with Argon2 key derivation
- Stored: `~/.vulcan/wallets/<name>.json` (mode 0600)
- Default wallet: `~/.vulcan/wallets/default` (plain text name)
- Private keys zeroized after use (`zeroize` crate)
- Agent plaintext private-key export: forbidden

### 6.7 Error Handling

```rust
ErrorCategory: Validation(1) | Auth(2) | Config(3) | Api(4) | Network(5)
             | RateLimit(6) | TxFailed(7) | Io(8) | DangerousGate(9) | Internal(10)
```

Output envelope: `{ "ok": false, "error": { "category", "code", "message", "retryable" } }`

---

## 7. Shared Phoenix Integration Details

### Rise SDK Usage

**TypeScript bot** (`@ellipsis-labs/rise@^0.4.9`):
- `createPhoenixClient()` for market metadata, PDA derivation, instruction builders
- `PhoenixHttpClient` for orderbook, candles, funding rates, trader state
- `createPhoenixWsClient()` for `traderState` + `allMids` channels
- `buildPlaceStopLoss()` for TP/SL orders (tick-based trigger prices)
- `buildDepositCollateral()` / `buildWithdrawCollateral()` via Ember proxy

**Rust Vulcan** (`phoenix-rise@0.1.2`):
- `PhoenixTxBuilder` for instruction construction
- HTTP + WS clients for market data and trader state
- Flight builder authority wrapping

### Flight Integration

- Builder authority pubkey configured in `BUILDER_AUTHORITY_PUBKEY` env var
- Bot validates pubkey length ≥ 43 chars before enabling Flight
- Users activated via `POST /v1/invite/activate` (access code) or `POST /v1/invite/activate-with-referral` (referral code)
- Builder fee: 10 bps default (configurable `BUILDER_FEE_BPS` 1–50)
- Fees accrue to builder's trader account on Phoenix; withdrawable from Phoenix frontend

### Blockhash Strategy

- 20-second TTL cache (`_cachedBlockhash` in `trade.ts`)
- Poll on cache miss: up to 60 attempts × 2 second delays = 2-minute max wait
- Jito tip: random selection from 10 hardcoded accounts at submission time
- Compute budget: 250k limit + 200k price (fixed)

---

## 8. Known Bugs (Documented in CLAUDE.md + Found in Code)

### From CLAUDE.md (Phase 0 backlog)

1. `alerts.ts` — alert toggle `findFirst` missing `type` filter → wrong subscription toggled
2. `deposit.ts` + `share.ts` — `replyWithPhoto` passes raw `Uint8Array`; needs `new InputFile(...)`
3. `long.ts` + `short.ts` — confirm callback regex `(\d+)` rejects decimal leverage values
4. `referral.ts` — T2 lookup can pick T2 row as parent; needs `eq(referrals.tier, "t1")` filter
5. `ws` / `@types/ws` missing from `package.json`
6. `vitest.config.ts` missing (fixed: now present in repo)
7. `src/db/schema/settings.ts` missing (fixed: now present in repo)

### Additional Bugs Found in Audit

| File | Location | Severity | Issue |
|------|----------|----------|-------|
| `preflight.ts` | line 152 | 🔴 Critical | Liquidation price formula is a simplified approximation — doesn't account for maintenance margin ratio, cross-margin collateral discount, or existing position PnL. Misleads users. |
| `trade.ts` | line 329 | 🔴 Critical | TP/SL ladder `level.fraction` is ignored — every rung closes the full position, not the partial fraction. Product gap. |
| `ws.ts` | line 156 | 🔴 Critical | Position flip detection uses Redis key with 1-hour TTL. Events arriving out-of-order or after TTL expire = missed flip alerts. |
| `leaderboard.ts` | line 18 | 🔴 Critical | GPA discriminant (`[41,97,73,105,110,214,112,9]`) hardcoded. If Phoenix changes account layout, scan returns empty with no alert. |
| `leaderboard.ts` | line 20 | 🔴 Critical | Authority extracted at hardcoded byte offset 56. Wrong bytes on layout change = corrupted leaderboard addresses silently. |
| `wallet.ts` | line 38 | 🔴 High | Privy key derivation strips prefix by string replace — fragile. Any prefix format change breaks signing silently. |
| `market.ts` | line 57 | 🔴 High | Orderbook mid can be null; falls back to 0. Zero mark price breaks all leverage/liq calculations downstream. |
| `position.ts` | line 54 | 🔴 High | Leverage approximated as `posValue / initialMargin`. Doesn't use effective margin → overstates leverage displayed to user. |
| `alerts.ts` | line 78 | 🔴 High | Default alert state inverted: `!(def?.default ?? true)`. New subscriptions created as disabled when they should be enabled. |
| `history.ts` | line 192 | 🔴 High | `trades[globalIdx]` — no bounds check. If page changes between clicks, index can be out of bounds → crash. |
| `trade.ts` | line 115 | ⚠️ Medium | Blockhash cache 20s TTL, but tx can stay pending up to 2 min. No retry with fresh blockhash on expiry. |
| `jobs/processors/alert.ts` | line 14 | ⚠️ Medium | Dedup key includes `symbol ?? ""` — for risk alerts (no symbol), all tiers share one dedup key. Only one risk alert per 5 seconds regardless of tier. |
| `ws.ts` | line 313 | ⚠️ Medium | `ownerUserIdCache` never expires. Stale entries after user deletion cause referral accrual to wrong user. |
| `referral.ts` | line 27 | ⚠️ Medium | Referral chain capped at 2 levels by design. Third-level referrers get no attribution. |
| `share.ts` | line 33 | ⚠️ Medium | ROI calculated as `pnl / notional` (exit notional). Should use entry price notional. Overstates ROI. |
| `withdraw.ts` | line 41 | ⚠️ Medium | Redis pending check not atomic — race condition if user clicks twice in quick succession. |
| `client.ts` | line 25 | ⚠️ Medium | Flight enabled by checking pubkey `length >= 43`. Malformed pubkey of right length silently disables Flight with no error. |
| `positions.ts` | line 292 | ⚠️ Medium | PnL card calculates realized PnL as `totalPnl * fraction`. Inaccurate if position had multiple partial fills at different prices. |
| `settp.ts` | line 170 | ⚠️ Low | Ladder prices split by comma from callback_data. No validation that exactly 3 levels present. |
| `candles.ts` | — | ⚠️ Low | TA indicators recomputed on every call. No caching. Will degrade under load. |
| `image.ts` | line 18 | ⚠️ Low | Font file loaded with `readFileSync`. If file missing, throws synchronously at module load. No fallback. |
| `action-log.ts` | line 52 | ⚠️ Low | ID generation: `Date.now().toString(36) + Math.random()`. Two logs at same ms can collide. Not guaranteed unique. |

---

## 9. Configuration & Environment

`src/config/index.ts` validates all env vars via Zod at startup. Crashes with field-level errors on failure.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token |
| `WEBHOOK_URL` | No | — | Set in production for webhook mode |
| `PRIVY_APP_ID` | Yes | — | Privy application ID |
| `PRIVY_APP_SECRET` | Yes | — | Privy app secret |
| `PRIVY_AUTHORIZATION_PRIVATE_KEY` | Prod only | — | Required unless TEST_KEYPAIR set |
| `TEST_KEYPAIR` | Dev only | — | Local keypair for dev; cannot coexist with prod |
| `BUILDER_AUTHORITY_PUBKEY` | Yes | — | Flight builder pubkey |
| `BUILDER_ACCESS_CODE` | Yes | — | Used to activate users via Phoenix API |
| `BUILDER_FEE_BPS` | No | 10 | 1–50 bps |
| `HELIUS_RPC_URL` | Yes | — | Must include API key in query params |
| `DATABASE_URL` | Yes | — | postgres.js connection string |
| `REDIS_URL` | Yes | — | ioredis connection string |
| `PHOENIX_API_URL` | No | `https://perp-api.phoenix.trade` | REST API base |
| `PHOENIX_WS_URL` | No | — | WebSocket endpoint |
| `PORT` | No | 3000 | Fastify server port |
| `HOST` | No | `0.0.0.0` | Fastify bind address |
| `ADMIN_TELEGRAM_IDS` | No | — | Comma-separated admin IDs for `/log` command |

---

## 10. Testing

### Unit Tests (`vitest`)

- `tests/unit/lib/errors.test.ts` — error classification and rendering
- `tests/unit/services/action-log.test.ts` — redaction, log writing, trackAction()
- `tests/unit/services/image.test.ts` — PnL card generation
- `tests/unit/services/lots.test.ts` — margin/lot unit conversion edge cases
- `tests/unit/services/market.test.ts` — market snapshot aggregation
- `tests/unit/services/preflight.test.ts` — preflight validation rules
- `tests/unit/services/referral.test.ts` — T1/T2 chain logic

### Integration Tests (`vitest.integration.config.ts`)

- `tests/integration/alerts.test.ts` — alert subscription toggling + delivery
- `tests/integration/referral.test.ts` — referral linking + fee accrual flow

### Config: `vitest.config.ts` now present (was in bug list, now fixed)

### Gap: No trade execution tests. No end-to-end Telegram interaction tests. All tests cover services only.

### Vulcan CLI Tests

- `vulcan/tests/cli_integration.rs` — CLI integration tests (Rust)
- `vulcan-lib/` — covered by Rust unit tests per module
- CI: `cargo nextest run` (configured in `.config/nextest.toml`)

---

## 11. Build & Tooling

### TypeScript Bot

- **Runtime**: Node.js, ESM (`"type": "module"`, NodeNext module resolution)
- **All imports must use `.js` extension** even for `.ts` source files
- **Linter**: Biome v1.9.4 (`pnpm check` / `pnpm format`)
- **Build**: `tsc --noEmit` then `tsc --emitDeclarationOnly` to `dist/`
- **Logger**: Pino with pino-pretty in dev
- **Dev polling**: grammY long-polling in dev, webhook in production

### Rust Vulcan CLI

- **Toolchain**: Rust stable (pinned in `rust-toolchain.toml`)
- **Async**: Tokio 1.44
- **Tests**: cargo nextest
- **Dependency audit**: cargo-deny (`deny.toml`)
- **Nix**: `flake.nix` for reproducible builds

---

## 12. Key Design Decisions & Trade-offs

### Bot: Privy Custodial Wallets

**Why**: Zero seed-phrase UX for Telegram users. Eliminates #1 friction in crypto onboarding.  
**Trade-off**: Bot operator holds custody. Users trust the bot. Privy's KMS is the attack surface.  
**Risk**: Privy key derivation code is fragile (prefix-strip + base64). Any Privy format change breaks signing.

### Bot: Separate Alert Worker

**Why**: Decouples real-time detection (WS worker) from Telegram delivery (alert worker). Alert delivery can fail/retry without affecting trade execution.  
**Trade-off**: Adds BullMQ dependency and operational complexity. Two more processes to deploy.

### Bot: Bot-Native Referral (vs Phoenix Native)

**Why**: Phoenix native referral requires $10K volume threshold. Bot-native has no threshold.  
**Trade-off**: Bot operator must fund rebates from builder fee margin. Not automatic.

### Bot: grammY Framework

**Why**: Most featureful Node.js Telegram bot framework. Built-in webhook support, middleware, parse-mode plugin.  
**Trade-off**: Heavier than telegraf. grammY-specific abstractions like context types.

### Vulcan: MCP-First Design

**Why**: AI agents (Claude, Cursor, Codex) can trade using the same tool catalog as CLI. Schema generated at build time — no drift.  
**Trade-off**: Two execution paths (CLI + MCP) to maintain. Every new command needs dual interface.

### Vulcan: Dangerous Gate Explicit Acknowledgment

**Why**: Live trades have real financial consequences. Prevents accidental agent execution.  
**Trade-off**: Verbose MCP calls. Agent must always pass `acknowledged: true` for live operations.

### Shared: Phoenix Rise SDK (Beta)

**Why**: Official SDK from Ellipsis Labs. Flight integration support.  
**Trade-off**: SDK is beta. Breaking changes possible. `npm` package name must be confirmed before launch. No SLA.

---

## 13. Product Roadmap (from PRD v1.1)

### MVP Phases (Q3 2026 launch target, 6–8 weeks)

**Phase 0 (Week 1–2):** Fix known bugs (see §8 backlog), establish test coverage  
**Phase 1 (Week 3–4):** Core trading — deposit/withdraw, long/short, position management, TP/SL  
**Phase 2 (Week 5–6):** Alerts, referral system, leaderboard, PnL share cards  
**Phase 3 (Week 7–8):** Wallet monitor, settings, markets browser, export

### Post-MVP Roadmap

- v2: Limit orders, conditional orders, portfolio analytics
- v3: Copy trading (blocked on Phoenix leaderboard API stabilization), isolated margin UI
- Ongoing: Vulcan strategy improvements, MCP agent ergonomics

### Success Metrics (90 days post-launch)

| Metric | Target | Stretch |
|--------|--------|---------|
| DAU | 200 | 500 |
| Daily Volume | $500K | $2M |
| Monthly Builder Fee | $3K–5K USDC | $15K USDC |

---

## 14. Security Surface

| Surface | Status | Risk |
|---------|--------|------|
| Privy KMS key derivation | Fragile prefix-strip logic | High |
| TEST_KEYPAIR guard | Zod validates can't coexist with prod | Good |
| Rate limiting | Redis INCR, 20 req/min | Good |
| Admin commands | Gated by ADMIN_TELEGRAM_IDS | Good |
| Withdrawal delay | 5-minute Redis timer | Good |
| Action log redaction | By key name only; generic keys not redacted | Medium |
| Vulcan wallet encryption | AES-256-GCM + Argon2 + mode 0600 | Strong |
| Vulcan dangerous gate | `acknowledged: true` + `--allow-dangerous` | Strong |
| Private key export | Dev-only in bot; agent-blocked in Vulcan | Good |
| SQL injection | Drizzle ORM parameterized queries | Good |
| Command injection | No shell exec; all external calls via SDK/HTTP | Good |

---

## 15. Open Questions (from PRD §8 + code inspection)

1. **Rise SDK package name**: `@ellipsis-labs/rise` is unconfirmed. Must verify with Ellipsis Labs before trade execution can work.
2. **`allMids` WS channel**: Channel name hardcoded; format and existence unverified in docs.
3. **Flight beta stability**: SDK is beta. Any breaking change from Ellipsis Labs breaks trade execution.
4. **GPA discriminant**: Hardcoded. No procedure to update if Phoenix changes account layout.
5. **Authority byte offset**: Hardcoded at 56. Must be verified against current Phoenix IDL.
6. **Builder fee rebate funding**: Who funds the USDC claims? Operator account? Process not implemented.
7. **Isolated margin UI**: Currently no way for users to create/select isolated subaccounts from the bot.
8. **Privy KMS policy engine**: PRD mentions KMS + policy engine needed. Not yet implemented.
9. **TP/SL partial close**: `buildPlacePositionConditionalOrder` mentioned as correct approach; current ladder implementation closes full position on each rung.
10. **Commodity markets (GOLD, SILVER, OIL, SKR)**: Isolated-only. No isolated subaccount creation flow yet.
