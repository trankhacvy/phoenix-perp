# Phoenix Perp Bot — Deep Research Report

## What It Is

A Telegram trading bot for **Phoenix Protocol perpetual futures**. Users interact entirely through Telegram: opening/closing positions, depositing/withdrawing collateral, setting TP/SL, monitoring portfolios, and earning referral fees. The bot creates **server-side embedded Solana wallets** (via Privy) so users never need to handle keys.

---

## Process Model (Three Independent Services)

The application is split into three Railway-deployed services that never call each other directly:

| Service | Entry Point | Role |
|---|---|---|
| **Bot** | `src/main.ts` | grammY bot + Fastify webhook server |
| **WS Worker** | `src/workers/ws.ts` | Phoenix WebSocket subscriptions, event detection |
| **Alert Worker** | `src/workers/alert.ts` | BullMQ consumer, Telegram message dispatch |

The WS worker detects events and writes jobs to a BullMQ `alertQueue`. The alert worker consumes those jobs and calls `bot.api.sendMessage`. This decoupling means real-time event detection and user notification are independently scalable and can fail without taking each other down.

---

## Startup (`src/main.ts`)

1. Validate all env vars via Zod (`src/config/index.ts`) — crashes loudly on any missing/invalid field
2. Initialize test signer if `TEST_KEYPAIR` env var is set (dev shortcut)
3. Start daily action log retention job (deletes entries >30 days old)
4. Mode selection:
   - **Production** (if `WEBHOOK_URL` set): Fastify server + Telegram webhook registration
   - **Development**: grammY long-polling, no server

---

## Request Pipeline

```
Telegram → POST /webhook/<token>  (Fastify)
  → authMiddleware         loads ctx.user from DB by telegramId
  → actionLogMiddleware    wraps execution, times it, writes DB audit entry
  → rateLimitMiddleware    Redis INCR, 20 req/min global / 5 orders/min
  → command handler        guards if (!ctx.user), executes logic
  → bot.catch()            converts errors to BotError, renders to user
```

**Multi-step flows** (e.g., long order entry) use Redis pending state:
- User sends `/long` → bot stores `pending:<telegramId>` = `"trade_leverage:long:SOL"` → asks for leverage
- User replies with text → `bot.on("message:text")` reads pending key → dispatches to next step → clears pending

---

## Database (Drizzle ORM + PostgreSQL)

Six schema files in `src/db/schema/`:

### `users`
Primary identity table. `id` = `telegramId` (string PK). Holds Privy userId, embedded wallet address, Phoenix activation status, and bot-native referral code.

### `alert_subscriptions`
Per-user alert type toggles. Eight alert types: `at_risk`, `cancellable`, `liquidatable`, `fill`, `tpsl_flip`, `price`, `funding_flip`, `large_funding`. `symbol` is nullable (null = all markets). `triggerPrice` only populated for price alerts.

### `wallet_monitors`
External wallet tracking. Users can watch any Solana address and get alerts on fills or position changes. Unique constraint on `(userId, watchedWallet)`.

### `referrals`
T1/T2 multi-level referral chain. `tier` is `"t1"` (direct) or `"t2"` (indirect). Tracks `accruedUsdc` and `claimedUsdc` as `numeric(20,6)` for precision.

### `user_settings`
Per-user defaults: `slippageBps` (default 50), `defaultLeverage` (default 5).

### `action_logs`
Audit trail for every command. Records command name, redacted args (jsonb), outcome, error code/category, duration in ms, and tx signature. Indexed on `(userId, createdAt)` and `(command, createdAt)` for efficient retention cleanup. Kept 30 days.

---

## Phoenix Integration (`src/services/phoenix/`)

### Market data (`market.ts`)
- `getMarkets()` — cached 60s
- `getMarketSnapshot(symbol)` — rich struct: `markPrice, tickSize, baseLotsDecimals, maxLeverage, takerFee, makerFee, fundingRate, leverageTiers[]`
- `ISOLATED_ONLY_MARKETS` — GOLD, SILVER, SKR, WTIOIL require isolated subaccounts (not cross-margin)
- `getOrderbook(symbol)` — mid-price, bid/ask levels

### Position tracking (`position.ts`)
- `getTraderState(walletAddress)` — aggregates cross + all isolated subaccounts, flattens all positions into a single list
  - Subaccount index 0 = cross-margin; >0 = isolated
  - Risk tier extracted from cross account
- `getTradeHistory(walletAddress)` + `fetchAllTradeHistory()` — paginated fills
- `computeWalletAnalytics(trades)` — PnL, win rate, best/worst trade, per-market breakdown

### Trading (`trade.ts`)
All functions accept a `KeyPairSigner` from `getKitSigner()`.

- `placeMarketOrder(params, signer)` → tx signature
- `placeLimitOrder(params, signer)` → tx signature
- `setTpSl(params, signer)` — supports multiple TP/SL levels per position, "market" (IOC) or "limit" execution
- `closePosition(symbol, walletAddress, signer, fraction=1)` — 0.5 = half close
- `cancelStopLoss(symbol, walletAddress, direction, signer)` — directions: `long_sl`, `long_tp`, `short_sl`, `short_tp`
- `addMargin(...)` — add collateral to open position
- `depositCollateral(...)` / `withdrawCollateral(...)` — account-level deposits/withdrawals

**Note**: The Rise SDK (`@ellipsis-labs/rise`) is listed in `package.json` at v0.4.9 but `client.ts` contains stubs that throw. Actual SDK integration is not yet implemented — all trade execution will fail until this bridge is completed.

### Size calculation (`lots.ts`)
- `marginToTokens(snap, marginUsdc, leverage, priceOverride?)` — converts USDC margin + leverage to base token amount, validates minimum size, rounds to `baseLotsDecimals`
- `fractionToCloseLots(rawLots, fraction)` — calculates base lots to close for a partial exit

### Preflight validation (`preflight.ts`)
Runs before every order placement. Checks:
1. Account is activated on Phoenix
2. Market is not isolated-only (for cross-margin orders)
3. Margin and leverage are within valid ranges
4. Market exists and has a valid price
5. Collateral balance covers margin + fees
6. Doesn't exceed leverage tier caps
7. Mark price hasn't drifted >50bps from anchor quote

Returns: effective leverage, notional size, fee breakdown, estimated liquidation price.

### Client singletons (`client.ts`)
- `getPhoenixClient()` — read-only, no Flight routing
- `getTradingClient()` — trading client with optional Flight builder routing (if `BUILDER_AUTHORITY_PUBKEY` is a valid pubkey)

---

## Wallet & Identity (`src/services/wallet.ts`)

- `createEmbeddedWallet(telegramUserId)` — Privy API creates server-side Solana wallet tied to Telegram ID. Users cannot export keys; the bot signs on their behalf.
- `getKitSigner(walletAddress)` — **currently throws** (Privy → @solana/kit bridge not implemented)
- `initTestSigner()` — dev helper: decodes `TEST_KEYPAIR` (base58) into a `KeyPairSigner` for testing without Privy
- `activatePhoenixAccount(walletAddress)` — POST `/v1/invite/activate` with `BUILDER_ACCESS_CODE`; activates builder fee routing

---

## Real-Time Monitoring (`src/workers/ws.ts`)

Dedicated worker subscribing to Phoenix WebSocket (`wss://perp-api.phoenix.trade/v1/ws`) for `traderState` events.

**Per event, detects**:
- **Position flip** (side changed after TP/SL execution) → queues `tpsl_flip` alert
- **Risk tier change** (atRisk, liquidatable) → queues risk alert
- **Trade fill** → queues fill alert + triggers referral fee accrual
- **Monitored wallet** fill/position change → queues alert for all watchers

**Connection management**:
- One WebSocket per unique wallet address (pooled)
- Watcher index: `wallet → Set<telegramId>` (multiple users can watch one wallet)
- Owner cache: `wallet → ownerTelegramId` (distinguishes self vs. monitored)
- 3 reconnect failures → notify owner, exponential backoff starting at 5s

---

## Alert Pipeline

```
WS worker detects event
  → alertQueue.add(type, { telegramId, message, symbol })
  → Alert worker dequeues
  → Redis NX check: dedup:<telegramId>:<type>:<symbol> (5s TTL)
  → If not duplicate: bot.api.sendMessage(telegramId, message)
  → Retry 3x with exponential backoff (1s, 2s, 4s) on failure
```

BullMQ keeps 100 completed jobs and 500 failed jobs in Redis for debugging.

---

## Bot Commands

25+ commands, all guarding `if (!ctx.user)`. Key flows:

| Command | Flow |
|---|---|
| `/start` | Create Privy wallet → activate Phoenix → show nav |
| `/long` / `/short` | Symbol picker → leverage → size → confirm → preflight → execute |
| `/deposit` / `/withdraw` | Amount → confirm → execute |
| `/positions` | Paginated list with TP/SL per position |
| `/history` | Trade history with PnL breakdown |
| `/portfolio` | Balance, collateral, PnL summary |
| `/markets` | Browse all markets (paginated) |
| `/settp` / `/setsl` | Choose market → position → mode → price → confirm |
| `/alerts` | Toggle alert subscriptions |
| `/referral` | Show code + stats |
| `/claim` | Claim accrued referral fees |
| `/share` | Generate PnL card image → `replyWithPhoto` |
| `/wallet-monitor` | Add/remove external wallets to watch |

---

## Message Formatting

**Mandatory pattern**: Always `@grammyjs/parse-mode` (`fmt` template literal + `FormattedString`). Never raw HTML strings or `parse_mode: "HTML"`.

```typescript
const msg = fmt`${bold("SOL · LONG")}  (Cross)
Entry  ${bold("$87.00")}`;
await ctx.reply(msg.text, { entities: msg.entities });
```

`src/bot/lib/fmt.ts` has helpers: `num()`, `usd()`, `price()`, `pct()`, `fundingApr()`, `pnlEmoji()`, `signedUsd()`.

---

## Error Handling

`BotError` class with fields: `category`, `code`, `userMessage`, `hint`, `retryable`.

`toBotError(err)` pattern-matches on 11+ regex patterns against SDK/network error messages and converts them to user-friendly structured errors. Categories: `validation`, `ratelimit`, `network`, `insufficient_funds`, etc.

`renderBotError(ctx, err, opts)` formats and sends the error with hint and retry indicator.

---

## Referral System (`src/services/referral.ts`)

Bot-native, independent of Phoenix's built-in referral (which requires $10K volume).

- **T1** (direct referral): referrer gets 20% of builder fees on referee's trades
- **T2** (indirect): if the referrer was themselves referred, their T1 referrer gets 10%

`linkReferral(refereeId, code)` creates both T1 and T2 rows atomically.
`accrueReferralFee(userId, notionalUsdc)` is called by the WS worker on every fill — looks up T1/T2 and updates `accruedUsdc`.

---

## Image Generation (`src/services/image.ts`)

`generatePnlCard(data)` renders a 1200×630px PNG trade card via:
- `satori` — JSX React elements → SVG
- `sharp` — SVG → PNG buffer

Output is sent via `/share` command using `replyWithPhoto`. Used for social sharing of profitable trades.

---

## Known Bugs (Phase 0, Unfixed)

1. **`alerts.ts`** — `findFirst()` missing `type` filter; wrong subscription may be toggled
2. **`deposit.ts` + `share.ts`** — `replyWithPhoto` receives raw `Uint8Array`, needs `new InputFile(buffer, "file.png")`
3. **`long.ts` + `short.ts`** — Confirm callback regex `(\d+)` rejects decimal leverage/size inputs
4. **`referral.ts`** — T2 lookup can pick a T2 row as the parent; needs `eq(referrals.tier, "t1")` guard
5. **`ws` package** — Not in `package.json` despite being imported in `src/workers/ws.ts`
6. **`vitest.config.ts`** — Was missing (tests couldn't run)
7. **`src/db/schema/settings.ts`** — Was missing; `userSettings` table was referenced but undefined

---

## ESM / Import Rules

`"type": "module"` + `"moduleResolution": "NodeNext"`. All imports use `.js` extensions even for `.ts` source files. No CommonJS `require()`.

---

## Environment Variables

Validated at startup by `src/config/index.ts` (Zod schema). Required:

| Var | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather token |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Embedded wallet API |
| `BUILDER_AUTHORITY_PUBKEY` | Phoenix Flight builder pubkey |
| `BUILDER_ACCESS_CODE` | Builder activation code for user onboarding |
| `PHOENIX_API_URL` / `PHOENIX_WS_URL` | Phoenix REST + WS endpoints |
| `HELIUS_RPC_URL` | Solana RPC |
| `DATABASE_URL` | PostgreSQL |
| `REDIS_URL` | Redis (pending state, rate limiting, BullMQ) |
| `WEBHOOK_URL` | (prod only) HTTPS URL for Telegram webhook |
| `TEST_KEYPAIR` | (dev only) base58 keypair for local signing |

---

## Testing Strategy

- **Unit tests** (`tests/unit/`): `action-log`, `lots`, `market`, `preflight`, `referral`, `errors` — pure logic, no DB
- **Integration tests** (`tests/integration/`): `alerts`, `referral` — end-to-end flows
- **Setup** (`tests/setup.ts`): sets mock env vars so config validation passes in test env
- Vitest with v8 coverage

---

## Key Architectural Decisions

1. **Job queue decoupling** — WS worker never calls bot API directly; always via BullMQ. Allows independent scaling and retry semantics.
2. **Server-side wallets** — Privy-managed embedded wallets eliminate the UX burden of key management. Trade-off: custodial trust model.
3. **Redis for everything ephemeral** — pending state, rate limiting, dedup keys, BullMQ backend. Single shared dependency.
4. **Three-process split** — bot, ws-worker, alert-worker are separate Railway services. Can crash and restart independently.
5. **Dual referral systems** — bot-native (T1/T2 by volume, accessible to all) vs. Phoenix native (requires $10K threshold). Bot-native is the primary incentive mechanism.
6. **Preflight as safety layer** — All orders validated before SDK call. Prevents silent failures from bad size, insufficient margin, or stale prices.
7. **Action log redaction** — Sensitive fields stripped before DB write. All user actions auditable without leaking secrets.

---

## Blocking Issues (Cannot Trade Until Fixed)

1. **Rise SDK not integrated** — `client.ts` stubs throw on all trade calls. SDK must be properly installed and bridged before any on-chain execution works.
2. **`getKitSigner()` not implemented** — Privy → @solana/kit signing bridge is a stub. Without this, no transaction can be signed in production.
3. **`ws` package missing** — WS worker will crash on import before any subscriptions start.
