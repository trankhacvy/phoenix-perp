# Shanghai v1 — Deep Codebase Research Report

## 1. What This Is

A **Telegram-native perpetual futures trading bot** for Phoenix Protocol on Solana. Users trade perps (long/short with leverage), manage collateral, set TP/SL, monitor wallets, and track leaderboards — all from Telegram. No web UI, no mobile app. Pure chat interface.

The bot acts as a **builder** on Phoenix via the Flight program, earning 10 bps taker fees on every trade routed through it.

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js (ESM, `"type": "module"`) |
| Language | TypeScript (strict, ES2022 target, NodeNext module resolution) |
| Bot framework | grammY (Telegram Bot API) |
| HTTP server | Fastify (webhook mode in prod, polling in dev) |
| Database | PostgreSQL via Drizzle ORM + postgres.js driver |
| Cache / Queue | Redis (ioredis) + BullMQ |
| Blockchain | Solana Web3.js v2 (@solana/kit, @solana/signers, @solana/web3.js) |
| Phoenix SDK | @ellipsis-labs/rise (trading client, metadata, WS streams) |
| Auth / Wallets | Privy (server-side embedded Solana wallets) |
| Image gen | Satori (JSX → SVG) + Sharp (SVG → PNG) |
| Technical analysis | technicalindicators (RSI, MACD, BB, ATR) |
| Logging | Pino (pino-pretty in dev) |
| Linting | Biome (formatter + linter) |
| Testing | Vitest (unit + integration configs) |
| CI/CD | GitHub Actions → Coolify webhooks |

---

## 3. Process Model

Single `main.ts` entry point starts everything:

```
main.ts
  ├── Alert worker        (BullMQ consumer, sends Telegram messages)
  ├── WS manager          (Phoenix WebSocket, risk/fill/price detection)
  ├── Leaderboard scanner (GPA discovery, periodic hydration)
  ├── Action log retention (daily sweep, 30-day TTL)
  └── Fastify server      (prod: webhook) / Grammy polling (dev)
```

Workers are modules with `start()`/`stop()` exports — not separate processes. Shutdown is coordinated via SIGTERM handler.

**CI/CD deploys 3 Coolify services** (bot, ws-worker, alert-worker) via matrix webhooks, but the codebase itself is a monolith.

---

## 4. Request Flow

```
Telegram → POST /webhook/<token> (Fastify)
  → grammY webhookCallback
  → authMiddleware      loads ctx.user from DB by telegramId
  → actionLogMiddleware derives command name, starts timer
  → rateLimitMiddleware Redis INCR, 20 req/60s global, 5 req/60s for orders
  → command handler     business logic
  → actionLogMiddleware logs outcome, duration, error code, tx signature
```

`ctx.user` is `undefined` for new users. `/start` handles onboarding. All other commands guard with `if (!ctx.user)`.

Multi-step flows (trade size → leverage → confirm) use **Redis pending state**: key `pending:<telegramId>` → value like `trade_size_input:long:SOL`. A catch-all `bot.on("message:text")` handler in `bot/index.ts` dispatches based on this key.

---

## 5. Database Schema (7 tables)

### users
Primary key: `id` (telegram user_id as string). Stores Privy wallet, Phoenix activation status, bot-native referral code. `walletAddress` is the Privy-managed Solana address.

### alert_subscriptions
Per-user alert type toggles. Types: `at_risk`, `cancellable`, `liquidatable`, `fill`, `tpsl_flip`, `price`, `funding_flip`, `large_funding`. Optional `symbol` (null = all markets). `triggerPrice` for price alerts (negative = below).

### referrals
Bot-native T1/T2 referral chain. Independent of Phoenix's native referral program (which requires $10K volume). `accruedUsdc` / `claimedUsdc` with numeric(20,6) precision.

### user_settings
`slippageBps` (default 50 = 0.5%) and `defaultLeverage` (default 5x). One row per user.

### wallet_monitors
Users can follow up to 10 external wallets. Triggers alerts on fills and position changes. Unique constraint on (userId, watchedWallet).

### action_logs
Audit trail: command, args (redacted), outcome, errorCode, errorCategory, durationMs, txSignature. Indexed on (userId, createdAt) and (command, createdAt). 30-day retention.

### leaderboard_snapshots
Trader discovery via GPA scan. Stores collateral, portfolio value, realized PnL, win/loss counts, total volume, position count, risk tier. `metadata` JSONB holds name/twitter/avatar/tags from `wallet-tags.json`. Indexed on portfolioValue, realizedPnl, updatedAt.

---

## 6. Phoenix Integration Details

### Collateral Model
- Solana USDC (`EPjFWdd5...`) ≠ Phoenix USDC (`PhUsd...`)
- **Ember proxy contract** wraps/unwraps 1:1 between them
- All deposits: user sends USDC to bot wallet → bot deposits into Phoenix via Ember
- Withdrawals: Phoenix → Ember unwrap → bot wallet → (optionally) external address
- Global withdrawal queue: 2M USDC budget, 450 USDC/slot rate limit

### Account Structure
- PDA: `(wallet_authority, portfolio_index, subaccount_index)`
- `subaccount_index=0` = cross-margin (shared collateral across positions)
- `subaccount_index>0` = isolated margin (per-position collateral)
- **Isolated-only markets**: GOLD, SILVER, SKR, WTIOIL — these require dedicated subaccounts

### Transaction Building
1. Build order instruction via Rise SDK
2. Attach signer (test keypair in dev, Privy kit signer in prod)
3. Construct transaction with:
   - Compute budget: 200k microLamports price, 250k unit limit
   - Jito tip: 200k lamports to random tip account (10-account rotation)
   - Recent blockhash (20s TTL)
4. Sign and send via Helius (skipPreflight=true, maxRetries=0)
5. Poll confirmation: 60 iterations × 2s, checks lastValidBlockHeight

### Builder Fees (Flight)
- 10 bps taker-only fee on every trade routed through the bot
- Collected as Phoenix collateral on the builder's trader account
- Builder activates users via `POST /v1/invite/activate` with `BUILDER_ACCESS_CODE`
- Referral rebate from these fees: 20% to T1 referrer, 10% to T2

---

## 7. Bot Commands (40+)

### Account
| Command | Purpose |
|---------|---------|
| `/start [code]` | Onboarding, Privy wallet creation, referral linking. Deep links: `pos_`, `hist_`, `mkt_`, `wallet_`, `long_`, `short_` |
| `/activate [code]` | Phoenix activation via builder access code |
| `/portfolio` | Full account snapshot: balances, positions, P&L, risk tier |
| `/deposit` | Two-step: send USDC to wallet → move to trading account |
| `/withdraw` | Internal (to bot wallet) or external (custom address). Two-step for external |
| `/settings` | Slippage (0.1–2%) and default leverage (2–50x) |
| `/wallet <address>` | Lookup any wallet's Phoenix activity, analytics, positions |

### Trading
| Command | Purpose |
|---------|---------|
| `/long [symbol] [leverage] [size]` | Open long. Guided flow: symbol → size → leverage → confirm |
| `/short [symbol] [leverage] [size]` | Open short. Same flow |
| `/positions` | List open positions with uPnL, liq price, leverage |
| `/setsl <symbol> <price>` | Set stop-loss. Preset %s (2/5/10/15/20%) or custom |
| `/settp <symbol> <price>` | Set take-profit. Preset %s (5/10/20/30/50%) or custom |

### Markets
| Command | Purpose |
|---------|---------|
| `/markets` | Paginated market browser (8 per page) with price, funding, OI |
| `/market <symbol>` | Detail: technicals (RSI, MACD, BB, ATR), funding trend, leverage tiers |
| `/funding` | Top 10 markets by funding rate magnitude |

### Monitoring & Alerts
| Command | Purpose |
|---------|---------|
| `/alerts` | Toggle global alert types (fill, at_risk, liquidatable, etc.) |
| `/alert <symbol> [price]` | Price alert for specific market |
| `/monitor [address]` | Watch external wallets (max 10). Copy/counter trade buttons |

### History & Social
| Command | Purpose |
|---------|---------|
| `/history` | Paginated trade history (5/page, last 30 fills) |
| `/share <symbol>` | Generate P&L card PNG (1200×630, dark theme) |
| `/leaderboard` | Top traders by volume/win_rate/realized_pnl |
| `/referral` | Referral link, T1/T2 stats, accrued/claimable |
| `/claim` | Claim referral rewards (min $1 USDC) |

### Admin/Dev
| Command | Purpose |
|---------|---------|
| `/exportkey` | Export Privy wallet private key (dev only) |
| `/log [user_id]` | Last 10 action log entries (admin only) |
| `/status` | Preview all 9 alert message formats (dev only) |

---

## 8. Trade Execution Flow (Detail)

### Size-First Flow
1. **Symbol picker**: paginated market list (8/page), each shows price + max leverage
2. **Size step**: preset buttons (10%, 25%, 50%, 100% of available margin) or custom input
3. **Leverage step**: dynamic buttons based on market's max leverage and leverage tiers, marks user's default with ★
4. **Confirm screen**: shows entry price, fee, estimated liquidation price, funding daily cost, slippage tolerance
5. **Execute**: calls `placeMarketOrder()` → awaits on-chain confirmation
6. **Success screen**: Solscan link, option to set SL/TP immediately

### Preflight Validation (`preflightOpen`)
Checks in order:
1. Phoenix activation status
2. Isolated-only market rejection (GOLD/SILVER/SKR/WTIOIL not supported yet)
3. Margin and leverage validity (finite, positive, leverage ≥ 1)
4. Market existence and live pricing
5. Collateral sufficiency (margin + fees ≤ available)
6. Leverage tier compliance (notional vs maxSizeBaseLots for the tier)
7. Price drift tolerance (default 50 bps based on user's slippage setting)

### Liquidation Price Calculation
- **Long**: `markPrice × (1 - 1/leverage + 0.5/maxLeverage)`
- **Short**: `markPrice × (1 + 1/leverage - 0.5/maxLeverage)`

### Lot Conversion
`marginToTokens(snap, marginUsdc, leverage, priceOverride)`:
- Formula: `(marginUsdc × leverage) / markPrice`
- Rounded down to `baseLotsDecimals` precision
- Throws SIZE_TOO_SMALL if below minimum lot

---

## 9. Real-Time Pipeline (WebSocket → Alerts)

### WS Manager Subscriptions
1. **traderState** (per-wallet): Position updates, risk tier changes, fills
   - Risk alert on tier change (atRisk, cancellable, liquidatable, etc.)
   - Position flip alert (side reversal = TP/SL triggered)
   - Fill alert with trade details
   - Referral fee accrual on fills
   - Caches positions in Redis (1h TTL)

2. **allMids** (all markets): Mid-price stream
   - Checks price alerts (above/below trigger)
   - 5s dedup per user/symbol/trigger

### Alert Pipeline
```
WS event detected
  → alertQueue.add(job)            BullMQ queue
  → Alert worker (concurrency: 10)
    → dedup check (Redis NX, 5s window)
    → bot.api.sendMessage()
    → retry on network/rate-limit (3 attempts, exponential backoff)
```

### Monitored Wallet Events
- `monitor_open`: New position opened by watched trader
- `monitor_flip`: Position side reversal
- `monitor_close`: Position closed
- `monitor_fill`: Trade fill on watched wallet
- Each includes copy/counter trade buttons (if not isolated-only market)

---

## 10. Leaderboard System

### Discovery
- **GPA scan**: Reads all Phoenix trader accounts on-chain
  - Program ID: `EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih`
  - Discriminant: `[41, 97, 73, 105, 110, 214, 112, 9]`
  - Extracts authority, quoteLotCollateral, numMarkets per subaccount
  - Aggregates across subaccounts per wallet
- **Bot user discovery**: Queries DB for Phoenix-activated users
- **Trade WS**: Subscribes to per-market trade channels, discovers new wallets from fills

### Hydration
- Fetches trader state + full trade history (up to 200 fills)
- Computes analytics: totalVolume, realizedPnl, win/loss counts, per-market breakdown
- Upserts into `leaderboard_snapshots` table
- Rate-limit aware: stops after 10 consecutive 429s

### Intervals
- **30 minutes**: Backfill stale traders (no history data)
- **2 hours**: Full GPA rescan + backfill with trade history
- **Continuous**: New trader discovery from trade WS channels (3600s dedup)

### Metadata
`data/wallet-tags.json` maps known wallets to names/twitter/avatars. Synced to DB via `syncWalletTags()`.

---

## 11. Referral System

### Mechanics
1. User A gets referral code on signup (8-char uppercase hex)
2. User B joins via `/start CODEA` → T1 record: B→A
3. If A was referred by Z, also creates T2 record: B→Z
4. T2 does NOT extend further (no T3)

### Commission
- T1: 20% of builder fee (10 bps × 20% = 2 bps of trade value)
- T2: 10% of builder fee (10 bps × 10% = 1 bps of trade value)
- Accrued per fill via `accrueReferralFee()` in WS worker
- Claimable via `/claim` (min $1 USDC)

### Known Bug
T2 chain lookup can pick a T2 row as the parent referrer. Needs `eq(referrals.tier, "t1")` filter to ensure it only walks T1 parents.

---

## 12. Image Generation

Two card types:
1. **P&L Card** (`generatePnlCard`): Shows symbol, side, leverage, entry/exit price, ROI%, PnL USD, duration, size
2. **Wallet Card** (`generateWalletCard`): Shows wallet address, realized PnL, win rate, total fills, volume, best/worst trade

Both are 1200×630 PNG. Dark background with win.jpg/lost.jpg overlay. Uses Space Grotesk font. Green for profit, red for loss.

Built with Satori (React JSX → SVG) + Sharp (SVG → PNG). No headless browser needed.

---

## 13. Error Handling

### BotError Class
Fields: `category`, `code`, `userMessage`, `hint`, `retryable`

### Categories
`validation`, `auth`, `config`, `api`, `network`, `ratelimit`, `tx_failed`, `io`, `gate`, `internal`

### Error Codes (20+)
`INSUFFICIENT_MARGIN`, `PRICE_DRIFT`, `SLIPPAGE_EXCEEDED`, `LEV_OUT_OF_RANGE`, `TIER_OVERFLOW`, `SIZE_TOO_SMALL`, `BLOCKHASH_EXPIRED`, `UNKNOWN_MARKET`, `ISOLATED_ONLY_MARKET`, `PHOENIX_NOT_ACTIVATED`, `RATE_LIMIT`, and more.

### `toBotError()` Mapping
Regex-matches raw error messages to BotError codes. Examples:
- "blockhash not found" → BLOCKHASH_EXPIRED (retryable)
- "429" / "rate limit" → RATE_LIMIT (retryable)
- "insufficient collateral" → INSUFFICIENT_MARGIN
- "slippage" → SLIPPAGE_EXCEEDED

### `renderBotError()`
Sends user-friendly error message to Telegram with optional Retry/Back buttons. Logs error details via action log middleware.

---

## 14. Redis Keys & TTLs

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `pending:<telegramId>` | 600s | Multi-step flow state |
| `ratelimit:<telegramId>` | 60s | Global rate limit counter |
| `ratelimit:orders:<telegramId>` | 60s | Order rate limit counter |
| `wd:ext:<telegramId>` | 600s | External withdraw confirmation |
| `wd:lock:int/ext:<userId>` | 150s | Withdraw double-submit prevention |
| `dedup:alert:<telegramId>:<type>` | 5s | Alert deduplication |
| `dedup:price:<userId>:<symbol>:<trigger>` | 5s | Price alert dedup |
| `monitor:events` | — | Pub/sub channel for wallet monitoring |
| `positions:<walletAddress>` | 3600s | Cached position data |
| `lb:seen:<walletAddress>` | 3600s | Leaderboard discovery dedup |

---

## 15. Caching Strategy

| Data | TTL | Location |
|------|-----|----------|
| Exchange config (metadata) | 5 min | In-memory (module-level) |
| Market snapshot | 30 sec | In-memory |
| Blockhash | 20 sec | In-memory |
| Positions | 1 hour | Redis |
| Price alert subscriptions | 30 sec | In-memory |
| Wallet tags | File-based | Synced on demand |

---

## 16. Testing Strategy

### Unit Tests (vitest.config.ts)
- `errors.test.ts`: BotError construction, toBotError mapping
- `fmt.test.ts`: fundingDailyUsd, liqDistanceLabel formatting
- `trade-flow.test.ts`: parseLeverage, order rate limiting
- `market.test.ts`: isIsolatedOnly classifier
- `lots.test.ts`: marginToTokens, fractionToCloseLots, edge cases
- `referral.test.ts`: Code generation (8-char hex, uniqueness)
- `preflight.test.ts`: Full preflightOpen validation (10+ scenarios)
- `image.test.ts`: P&L card buffer generation
- `action-log.test.ts`: Argument redaction (sensitive fields)

### Integration Tests (vitest.integration.config.ts)
- `referral.test.ts`: Full T1/T2 chain against real DB
- `alerts.test.ts`: Alert subscription toggling against real DB
- 30s timeout for DB operations

### Live Tests (scripts/)
- `test-onchain.ts`: 50-round open/close loop against real Phoenix (no Telegram)
- `test-bot.ts`: Full command flow with mocked Telegram API against real Phoenix/Solana
- `verify-gpa.ts`: Compare on-chain GPA data vs REST API state

### CI Pipeline
- PostgreSQL 16 + Redis 7 services
- `pnpm check` → `pnpm build` → `pnpm test:coverage`
- Deploy on push to main via Coolify webhooks (3-service matrix)

---

## 17. Known Bugs (from CLAUDE.md)

1. **alerts.ts**: `findFirst` missing `type` filter when toggling alerts — can toggle wrong subscription
2. **deposit.ts + share.ts**: `replyWithPhoto` receives raw `Uint8Array` instead of `new InputFile(...)` — photo sends fail
3. **referral.ts**: T2 chain lookup can pick T2 row as parent — needs `eq(referrals.tier, "t1")` filter
4. **package.json**: `ws` / `@types/ws` not listed as dependencies (imported in `ws.ts`)

---

## 18. Formatting Conventions

All bot messages use `@grammyjs/parse-mode` with entity-based formatting (never raw HTML):
- `fmt` tagged template for composition
- `FormattedString.b()`, `.i()`, `.code()`, `.link()` for inline styles
- `FormattedString.join(arr, separator)` for lists
- Always pass `{ entities: msg.entities }`, never `{ parse_mode: "HTML" }`
- `link_preview_options: { is_disabled: true }` when URLs present

Number formatting:
- `usd(n)`: $X,XXX.XX
- `price(n)`: Smart decimals by magnitude
- `pct(n)`: +X.XX% with sign
- `compactUsd(n)`: $1.2M, $500K (leaderboard)
- `shortAddr(addr)`: first4...last4
- `timeAgo(ts)`: "2h ago", "3d ago"

---

## 19. Environment & Config

All env vars validated via Zod at startup (`src/config/index.ts`). Crashes with field-level errors on missing required vars.

Key validations:
- `TEST_KEYPAIR` forbidden in production
- `PRIVY_AUTHORIZATION_PRIVATE_KEY` required unless `TEST_KEYPAIR` is set
- `BUILDER_FEE_BPS` clamped to 1-50
- URLs validated with `z.string().url()`

Required in all environments: `TELEGRAM_BOT_TOKEN`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `BUILDER_AUTHORITY_PUBKEY`, `HELIUS_RPC_URL`, `DATABASE_URL`, `REDIS_URL`

---

## 20. Key Design Decisions

1. **Single process, not microservices**: All workers run in one process. Simpler deployment, shared memory for caches, coordinated shutdown. CI/CD deploys 3 Coolify services but they're the same codebase.

2. **Privy for wallets, not self-custody**: Server-side embedded wallets. Users never see private keys (except dev `/exportkey`). Removes seed phrase UX friction.

3. **Bot-native referrals, not Phoenix referrals**: Phoenix's native referral program requires $10K volume. Bot's system is independent — any user gets a code on signup.

4. **Entity-based formatting, not HTML**: Avoids HTML injection risks. Grammy's parse-mode handles entity offset math automatically.

5. **GPA scan for leaderboard**: Reads all Phoenix trader accounts directly from Solana (memcmp filter on discriminant bytes). No dependency on Phoenix API for discovery.

6. **Jito tips on every trade**: 200k lamports to random tip account from 10-account rotation. Ensures MEV protection and faster inclusion.

7. **Preflight before every trade**: Full validation pass (collateral, leverage tiers, price drift, activation) before building any transaction. Prevents wasted SOL on failed txs.

8. **Action log retention**: 30-day auto-sweep. Prevents unbounded growth while keeping enough history for debugging.

9. **Redis pending state with 600s TTL**: Multi-step flows auto-expire. No stale state if user abandons mid-flow.

10. **5-second alert dedup window**: Prevents duplicate Telegram messages when WS events fire rapidly (e.g., multiple fills in same block).
