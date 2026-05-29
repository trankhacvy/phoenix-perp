# SuperNova (phoenix-perp) — Deep Research Report

> A Telegram bot for trading perpetual futures on **Phoenix** (Ellipsis Labs' on-chain perp DEX on Solana), accessed entirely from chat. Package name `supernova-bot`, product name **SuperNova**, PRD codename **PhoenixPerpBot**.

Date of report: 2026-05-29. Branch: `feat/remotion`.

---

## 1. What it is (product)

SuperNova lets a Telegram user create a wallet, deposit USDC, and open/close leveraged long/short perpetual positions on Phoenix — without ever leaving Telegram. Everything is chat-driven: slash commands, inline keyboards, and multi-step guided flows.

Core value props (from PRD v1.1):
- **Zero-friction onboarding** — a Privy server-side embedded Solana wallet is minted on `/start`; no seed phrase, no external wallet.
- **Guided trading** — `/long`/`/short` walk through size → leverage → confirm with a full preflight quote (fees, liquidation price, slippage).
- **Risk automation** — "Guardian" rules auto-close/reduce/add-margin or maintain trailing-stop/breakeven brackets on-chain.
- **Live alerts** — risk-tier, fill, liquidation, price, position-flip alerts pushed over Telegram.
- **Social/growth** — follow other traders ("monitor"), a discovered leaderboard, bot-native referral with points + shareable PnL/QR cards.

Markets: 29+ Phoenix perp markets. Commodity markets (GOLD, SILVER, SKR, WTIOIL) are **isolated-margin only** and gated. Copy-trading and Phoenix-native referral were explicitly cut from MVP.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Language / runtime | TypeScript, Node ESM (`"type":"module"`, `moduleResolution: NodeNext` — all imports use `.js` extensions) |
| Bot framework | grammY + `@grammyjs/parse-mode`, `@grammyjs/runner`, `@grammyjs/auto-retry` |
| Web server | Fastify v5 (webhook receiver + `/health`) |
| Perp SDK | `@ellipsis-labs/rise` (the "Rise" SDK = Phoenix client) |
| Solana | `@solana/kit` v6 (modern kit-style), `@solana/web3.js` v1, `@solana-program/*` |
| Wallets | Privy (`@privy-io/node`, `@privy-io/server-auth`) — app-owned embedded wallets |
| DB | PostgreSQL via Drizzle ORM + `postgres.js` |
| Queue / cache | BullMQ + ioredis (Redis) |
| Image cards | satori (SVG) + `@resvg/resvg-js`/sharp (PNG) + qrcode |
| Logging | pino / pino-pretty |
| Lint/format | Biome |
| Tests | Vitest (unit + integration) |
| Pkg manager | pnpm 10 |

Build: `tsc --noEmit && tsc`. Dev: `tsx watch src/main.ts` (single process runs everything).

---

## 3. Process model — one process, many components

Everything boots from `src/main.ts:main()`. There is **no separate worker process**; workers are modules with `start*/stop*` exports started in sequence:

```
startActionLogRetention()   // daily DELETE of action_logs > 30d
startAlertWorker()          // BullMQ consumer → Telegram sends
startRestRefreshLoop()      // 20s REST poll of trader state (liq price, margin, risk tier)
startPriceFeed()            // Phoenix WS allMids → in-mem price map
startAllMarketStats()       // Phoenix WS marketStats → funding/volume/OI cache
startPriceAlertWatcher()    // price-cross alert evaluator (price-driven)
startEvalLoop()             // 1Hz risk/guardian evaluation loop
await startWsManager()      // Phoenix WS traderState subscriptions (per user + monitored)
startLeaderboardScanner()   // prod-only by default; GPA discovery + REST hydration
```

`setMyCommands` registers the 18 visible slash commands. Then either **webhook mode** (production + `WEBHOOK_URL`: Fastify listens, `setWebhook` with a SHA256-derived slug `/webhook/<32hex>` and `WEBHOOK_SECRET`) or **long-polling** (`bot.start`, dev). Graceful shutdown on SIGTERM/SIGINT stops every component; `uncaughtException` triggers shutdown, `unhandledRejection` is logged.

Config (`src/config/index.ts`) is Zod-validated at startup and **crashes with field-level errors** on bad env. Notable vars: `TELEGRAM_BOT_TOKEN`, `PRIVY_APP_ID/SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY` (bot-first signing key), `BUILDER_AUTHORITY_PUBKEY` + `BUILDER_FEE_BPS` (default 5) + `BUILDER_ACCESS_CODE` (Flight builder fees), `HELIUS_RPC_URL`, `DATABASE_URL`, `REDIS_URL`, `PHOENIX_API_URL`/`PHOENIX_WS_URL`. Dev-only `DEV_SIGNER_SECRET_KEY` bypasses Privy signing.

---

## 4. Request flow (bot)

```
Telegram → POST /webhook/<slug> (Fastify, secret-token checked)
  → handleWebhook (grammY webhookCallback "fastify")
  → sequentialize(getSessionKey)   // serialize per-user, avoid races
  → rateLimitMiddleware            // Redis INCR, 20 req / 60s
  → authMiddleware                 // load ctx.user from DB by telegramId
  → actionLogMiddleware            // time + audit-log the command
  → command / callback / text handler
```

- `ctx.user` is `undefined` for new users; `/start` onboards, all other commands guard `if (!ctx.user)`.
- **Order rate limit** is separate and stricter: 5 orders/60s (`ratelimit:orders:{id}`), checked inside `/long`/`/short` confirm paths.
- **Multi-step flows** use Redis pending state `pending:{telegramId}` (TTL 600s) → `action:args`. A single `bot.on("message:text")` dispatcher in `src/bot/index.ts` (the bulk of that file) parses the pending key and routes free-text input.
- **Idempotency**: `claimIdempotencyKey(userId, callbackId)` = Redis `SET ... NX EX 120` to dedup double-tapped buttons. Trade execution also takes a `trade:lock:{userId}` (NX, 150s).

---

## 5. Identity & wallets (`src/services/wallet.ts`, `src/lib/privy.ts`)

- `telegramId` (string) is the primary identity. On `/start`, `createEmbeddedWallet(telegramUserId)`:
  1. `privy.users().create({ linked_accounts: [{ type:"telegram", telegram_user_id }] })`
  2. `privy.wallets().create({ chain_type:"solana", owner:{ public_key: getAppPublicKey() } })`
  - The wallet **owner is the app's authorization public key**, so the bot signs server-side without a user JWT (bot-first custody).
- `getPrivyKitSigner(walletAddress)` returns a `@solana/kit` signer:
  - **Dev bypass**: non-prod + `DEV_SIGNER_SECRET_KEY` → local `KeyPairSigner` from base58 secret.
  - **Prod**: resolves `privyWalletId` from DB, builds `createSolanaKitSigner` with the authorization context.
- Balance helpers: `getWalletUsdcBalance` (idle USDC in the bot wallet — standard mint `EPjFW…`, **not** Phoenix collateral) and `getSolBalance` (gas; returns 0 on RPC error rather than throwing).

> Phoenix uses a distinct **Phoenix USDC** (`PhUsd…`) wrapped 1:1 from standard USDC through the **Ember proxy contract**; all deposits/withdrawals go through it.

---

## 6. Phoenix / Rise integration (`src/services/phoenix/*`)

### 6.1 Clients (`client.ts`)
Three lazy singletons over a shared base (`apiUrl`, `rpcUrl=Helius`, `exchangeMetadata.stream=false`):
- `getPhoenixClient()` — **read** client (markets, positions, candles, funding, orderbook).
- `getTradingClient()` — **trading** client; enables **Flight routing** (`flight.builderAuthority`) only when `BUILDER_AUTHORITY_PUBKEY.length >= 43` (guards against the stub `"111…1"` pubkey panicking the proxy).
- `getPhoenixWsClient()` — WS client with exponential backoff (1s→30s). A Node polyfill installs `ws` as global `WebSocket`.

### 6.2 Markets & math (`market.ts`, `lib/amount.ts`, `conditional.ts`)
- `getExchangeConfig()` cached 5 min; `getMarketSnapshot(symbol)` cached 30 s (markPrice, tickSize, baseLotsDecimals, maxLeverage, taker/maker fee, funding, OI, leverage tiers).
- `ISOLATED_ONLY_MARKETS = {GOLD, SILVER, SKR, WTIOIL}`; `isIsolatedOnly()` prefers live exchange config, falls back to the set.
- **Account PDA**: `(authority, traderPdaIndex=0, subaccountIndex)`. `subaccountIndex=0` = cross-margin; `>0` = isolated. Conditional-orders PDA derived from the trader PDA.
- **Number discipline** (`docs/number-formatting.md`): anything tx-bound never passes through a JS float. `toNative(decimalString, decimals)` parses a human string → `bigint`; `fromNative` reverses; `tokensToLots` = `toNative(str, baseLotsDecimals)`. Three layers — L1 on-chain integer (bigint, exact), L2 derived analytics (number, approximate), L3 display formatters.
- Ticks↔USD: `ticksToPriceUsd = ticks * tickSize * 10^(baseLotsDecimals − 6)`; `priceUsdToTicksBig` uses the SDK helper. `QUOTE_DECIMALS = 6`.

### 6.3 Trade execution (`trade.ts`)
- `placeMarketOrder` / `placeLimitOrder` build order packets via the SDK (`Side.Bid`=long, `Side.Ask`=short) then `dispatchInstruction`.
- `closePosition(symbol, wallet, fraction=1)` reads the snapshot, computes close lots from `basePositionLots` (positive=long, negative=short), and submits an IOC packet with `OrderFlags.ReduceOnly`.
- `depositCollateral` / `withdrawCollateral` build Ember-proxy deposit/withdraw ixs and `dispatchInstructions` (batched).
- **Dispatch internals**: compute-budget (price + 250k limit), the signed instruction(s), then a **Jito tip** SOL transfer to a randomly-rotated tip account; sent via **Helius Sender** (`skipPreflight`, `maxRetries:0`); confirmation polled up to 60×@2s. Fee presets: `eco`/`normal`/`turbo` (tip lamports + CU price). SOL preflight (`checkSolPreflight`) and blockhash are cached and invalidated after send.

### 6.4 Conditional orders = TP/SL (`conditional.ts`)
- `buildPlacePositionConditionalOrder` per rung; ladder-capable, atomic single-tx writes. **Max 8 active rungs per market** per trader account.
- **Direction map**: `isGreater = (tp && long) || (sl && short)` → `Direction.GreaterThan`, else `LessThan`; `tradeSide` = opposite of position side. Long TP→greater, long SL→less, short flipped.
- **Market mode** = IOC with ±10% execution buffer (`computeMarketExecutionTicks`: ask ×0.9, bid ×1.1); **limit mode** = limit at trigger price.
- PDA init (`buildCreateConditionalOrdersAccount`, capacity 8) is **lazy** — bundled into the first TP/SL tx per wallet.
- Cancel by `conditionalOrderIndex` parsed from the trader-state trigger id `ctp-{assetId}-{idx}-{gt|lt}` / `csl-…` via `parseConditionalId`.
- `validateTriggerPrice` enforces TP/SL sit on the correct side of mark and SL not beyond liquidation.
- Rung sizing (`resolveSize`): `full | lots | tokens | percent`.

### 6.5 Positions (`position.ts`)
- `getTraderState(wallet)` REST-fetches all subaccounts; side derived from `virtualQuotePosition.value` (`<=0`→long); mark price computed as `positionValue/positionSize`; leverage ≈ `positionValue/initialMargin`; aggregates uPnL + unsettled funding across subaccounts. subaccount 0 = cross.
- `computeWalletAnalytics(trades)` → volume, realized PnL, win rate, best/worst, per-market breakdown (powers wallet lookup + leaderboard hydration).

### 6.6 Real-time feeds
All feeds run under `superviseFeed(name, signal, body)` (`feed-supervisor.ts`) — exponential backoff 1s→30s, reset on each live message, self-healing reconnect.
- `price-feed.ts` — `allMids` WS → `mids` map + pub/sub (`onMids`).
- `market-stats-feed.ts` — `marketStats` WS → per-symbol cache (mark/oracle, 24h change, volume, OI, funding 1h/8h/annualized).
- `trades-feed.ts` — custom `registerSubscription("trades", …)` exposing `subscribeMarketTakers(symbol, cb)` (used by leaderboard discovery). (Has a Zod v3/v4 cast bridge — SDK is v4, project v3.)
- `preflight.ts` — `preflightOpen` validates activation, isolated-only, margin/leverage finiteness, collateral ≥ margin+fee, leverage-tier ceiling, price-drift vs anchor (slippage bps, default 50), and approximates liquidation price.
- `rest-limit.ts` — `TokenBucket(4, 3)` (burst 4, 3/s) gates **every** Phoenix REST call.

---

## 7. Background workers & risk/alert pipeline

### 7.1 WS manager (`workers/ws.ts`)
- On start: subscribes the bot's own users (`{fills:true, posChange:true}`) and all enabled `wallet_monitors` (per-watcher flags). Listens on Redis `monitor:events` for dynamic (un)subscribe.
- Streams `traderState(wallet, 0)`; each update → `applyTraderState` merges into a cached `AccountSnapshot` (via `trader-state-merge.ts`).
- On position-array change → `runStructuralEvaluators`: position-flip (owner) + monitor alerts (watchers); clears peak/trail Redis state for closed positions.
- On fills → accrues referral points (`accrueReferralPoints`), queues owner liquidation alerts, emits monitor fill/liquidation alerts.
- Exposes `getOwners()`/`getSnapshot()` consumed by the eval loop; `markRestDirty()` flags wallets for REST refresh.

### 7.2 Eval loop (`workers/eval-loop.ts`)
- Runs at **1 Hz** and also eagerly on each `onMids` tick; re-entrancy guarded by a `running` flag.
- Per owner with positions: `deriveMetrics(snapshot, mids)` (mark, per-position uPnL, total notional), pulls `getRestDerived` (from rest-refresh cache), then runs `evaluateRiskTier` + `evaluateGuardianRules`.

### 7.3 Evaluators (`workers/evaluators/*`)
- **risk-tier** — maps Phoenix risk tier (`atRisk`/`cancellable`/`liquidatable`/`backstopLiquidatable`/`highRisk`) → alert; dedup `ws:dedup:{id}:risk:{type}` 300s.
- **guardian** — loads cached active rules; checks snooze + cooldown; rule types: `liq_distance`, `drawdown` (Redis peak-PnL tracking), `pnl_target`, `funding_drain`, `exposure_limit`, `margin_ratio`, plus auto-bracket handlers `trailing_stop` (0.3% step, 20s throttle, on-chain SL update) and `breakeven` (entry+0.1% once PnL% hit, once per position). Actions: `suggest` (queue alert + action buttons) or auto `auto_close`/`auto_reduce`/`auto_margin` (guarded by `guardian:auto:lock:{userId}` 150s).
- **monitor** — diff new vs prev positions of a watched wallet → `monitor_open`/`monitor_flip`/`monitor_close` + fill/liquidation alerts to watchers, with copy/counter/view buttons.
- **position-flip** — owner side flip → `tpsl_flip` alert (old TP/SL invalidated), dedup 60s.
- **price-alert** (`startPriceAlertWatcher`) — price-driven, throttled 1/s; crosses trigger → fire once (dedup 3600s), then disables the subscription row.

### 7.4 REST refresh (`workers/rest-refresh.ts`)
20s sweep + dirty-set drain; per wallet caches `riskTier`, `effectiveCollateral`, `liqPriceBySymbol`, `marginBySymbol` (WS traderState is price-blind for these). Rate-limited.

### 7.5 Alert pipeline (`jobs/queues.ts`, `jobs/processors/alert.ts`)
- `alertQueue` (BullMQ): 3 attempts, exponential backoff, keep last 100 done / 500 failed.
- `AlertJobData { telegramId, type, message, entities?, symbol?, keyboard? }`.
- Worker concurrency 10; **dedup** `alert:dedup:{id}:{type}:{symbol}` = Redis `SET NX EX 5` (5s window); sends via `bot.api.sendMessage` with entities (preferred) or `parse_mode:HTML` (legacy callers), link preview disabled.

### 7.6 Leaderboard (`workers/leaderboard.ts`, `services/leaderboard.ts`)
- Prod-only by default. Phases: load wallet tags → **GPA discovery** (`getProgramAccounts` with TRADER_DISCRIMINANT, aggregate per authority) → seed/upsert `leaderboard_snapshots` → hydrate changed via REST → discover bot users → subscribe market-taker WS for live new traders.
- Recurring: 30-min stale backfill, 2-hour full rescan. Token-bucket `TokenBucket(2, 0.5)` keeps under Phoenix ~5 req/s. New WS-discovered takers dedup `lb:known:{wallet}` 1h then hydrate.
- `getLeaderboard(sortBy, page)` over `total_volume | win_rate | realized_pnl`, filtered to active (collateral ≠ 0).

---

## 8. Bot command surface (`src/bot/commands/*`)

18 registered commands. Brief map:

| Command | Purpose |
|---|---|
| `/start [code]` | Onboard (mint Privy wallet, referral code) or dashboard; deep links: `pos_`, `hist_`, `mkt_`, `wallet_`, `long_`, `short_`, `grd_`. New-wallet rate-limited 10/60s globally. |
| `/activate [code]` | Gate trading: POST `/v1/invite/activate` (builder access code), fallback activate-with-referral; sets `phoenixActivated`. |
| `/long` `/short` `[sym][lev][size]` | Size-first guided flow or one-shot inline. |
| `/positions` | List + per-position detail (close 25/50/100%, add margin, TP/SL, refresh, share PnL). |
| `/markets` `/market <sym>` | Browse markets (funding/volume) + detail (orderbook, technicals). |
| `/deposit` `/withdraw` | Ember-proxy collateral in/out; withdraw to bot wallet (1 tx) or external (2 tx). Redis double-submit locks. |
| `/portfolio` | Wallet USDC, trading collateral, available margin, uPnL, positions, SOL gas, risk tier. |
| `/history` | Trade log with realized PnL. |
| `/wallet <addr>` | Any-trader stats + share card. |
| `/monitor` | Follow wallets → live alerts (copy/counter buttons). |
| `/guardian` | Risk rules + auto-protection (callbacks `grd_*`, `protect_*`). |
| `/alerts` `/pricealert` | Price & account alerts toggles. |
| `/leaderboard` | Top traders by volume/pnl/winrate. |
| `/settings` | Slippage, default leverage, confirm toggles, fee mode, auto TP/SL %. |
| `/referral` | Link, points, rank, QR card. |
| `/help` `/status` `/log` `/testcard` | Help, health, personal action log, card-render test. |

### 8.1 Trade flow (size-first)
`/long` → symbol picker → **size step** → **leverage step** → **confirm** (full quote) → execute.
- Callback namespace: `trade_sym:`, `trade:`, `trade_size:`, `trade_size_custom:`, `trade_lev:`, `trade_lev_custom:`, `trade_refresh:`, `confirm:side:sym:lev:size:anchorPrice`.
- Pending keys: `trade_size_input:side:SYMBOL`, `trade_lev_input:side:SYMBOL:AMT`.
- `executeTrade` takes `trade:lock`, edits to `CONFIRMING`, runs `placeMarketOrder` inside `trackAction`, records the trade, subscribes the user to WS, and — if `autoTpPct`/`autoSlPct` set — places brackets ~2s later. Anchor price uses `toPrecision(12)`; decimal leverage (`2.5x`) accepted; price drift offers inline refresh instead of restarting. `confirmTrades=false` skips the confirm screen.

### 8.2 TP/SL flow (`commands/tpsl.ts`)
- Entry from a position: `🎯 Set TP` / `🛑 Set SL`, or the bracket-first **Protect** screen (tight/balanced/runner one-tap plans).
- Callback namespace `tpsl:*` (open/px/px2/pxc/sz/szc/go/row/editpx/editsz/flipmd/rm/rmgo/split/splitgo/clr/clrgo).
- Pending keys: `tpsl_px:LEG:SYM:SIDE`, `tpsl_sz:LEG:SYM:SIDE:PX`, `tpsl_editpx:…:IDX`, `tpsl_editsz:…:IDX`.
- "Split into ladder" atomically cancels a full-coverage rung and places two 50/50 rungs.

---

## 9. Shared bot libs (`src/bot/lib/*`)

- **errors.ts** — `BotError` with `category` (validation/auth/api/network/ratelimit/tx_failed/gate/…) + `code` (INSUFFICIENT_MARGIN, PRICE_DRIFT, ISOLATED_ONLY_MARKET, TIER_OVERFLOW, BLOCKHASH_EXPIRED, …). `toBotError` pattern-matches SDK/RPC errors; `renderBotError` formats + sends with hint and retry button. **All errors route through these.**
- **tx-flow.ts** — locked on-chain copy: `SUBMITTING`, `CONFIRMING`, `txSuccess` (✅ + Solscan link), `txError`, `TX_MSG_OPTS` (link preview off). Never hand-rolled.
- **fmt.ts** — semantic formatters: `money`/`signedMoney` (exact), `moneyShort`/`compactNum` (compact ≥1000), `price`, `tokenSize`, `percent`, `parseAmount`, `parseLeverage`, `solscanUrl`, `timeAgo`, `shortAddr`, funding/liq helpers. No raw `.toFixed()` or `$${}` in the command layer.
- **terms.ts** — locked terminology: "bot wallet", "trading account", "margin", "position size", "liquidation price".
- **pending.ts** — `setPending/getPending/clearPending` (Redis `pending:{id}`, 600s).
- **idempotent.ts** — claim-once per callback (`SET NX EX`).
- **activation.ts** — `requireActivation(ctx)` gate.
- **paginate.ts**, **validate.ts** (base58 regex), **referral-link.ts** (deep link + badge).

All bot messages use `@grammyjs/parse-mode` `fmt`/`FormattedString` and send `{ entities }` — **never** `parse_mode:"HTML"` (legacy alert callers excepted, which must `esc()`).

---

## 10. Database schema (Drizzle, Postgres)

| Table | Key columns / notes |
|---|---|
| **users** | PK `id`(=telegramId string); `privyUserId`, `privyWalletId`, `walletAddress`, `phoenixActivated`, `referralCode` (8-hex unique), `referredBy`. |
| **alert_subscriptions** | `userId` FK, `type` enum (at_risk, cancellable, liquidatable, fill*, tpsl_flip, price, funding_flip*, large_funding*), `symbol` (null=all), `triggerPrice`, `enabled`. (* deprecated, retained.) |
| **referrals** | `referrerId`/`refereeId` FK, `tier` (t1 active / t2 legacy), **`points`** numeric (1 pt/$1 taker notional), legacy `accruedUsdc`/`claimedUsdc` (no longer written). |
| **user_settings** | PK `userId`; `slippageBps`(50), `defaultLeverage`(5), `confirmTrades`, `confirmClose`, `feeMode` enum, `customFeeSol`, `autoTpPct`, `autoSlPct`. |
| **wallet_monitors** | `userId`+`watchedWallet` unique; `label`, `alertOnFill`, `alertOnPositionChange`, `enabled`. |
| **action_logs** | audit: `command`, `args`(jsonb, **redacted**), `outcome` enum, `errorCode/Category`, `durationMs`, `txSignature`; indexed (userId,createdAt)/(command,createdAt); 30-day retention sweep. |
| **leaderboard_snapshots** | `walletAddress` unique; collateral/effective/uPnL/portfolioValue/funding, `riskTier`, `positionCount`, `totalVolume`, `realizedPnl`, win/loss/totalTrades, `discoveredVia` (gpa/ws_trades), `lastUpdateSlot`, `metadata` jsonb (tags), hydration timestamps; indexed by portfolio/realizedPnl/updatedAt/slot. |
| **trades** | per-execution log: symbol, side, action (open/close), margin, leverage, notional, baseUnits, markPrice, fee, closeFraction, txSignature; **fire-and-forget** insert. |
| **guardian_rules** | `ruleType` enum (8), `symbol`/`side` (null=all/both), `threshold`, `direction`, `action` enum, `actionParam`, `cooldownSec`(300), `lastTriggeredAt`, `enabled`; 30s in-mem cache. |

13 migrations (`0000`–`0012`). Note two parallel `0005`/`0006` filenames exist (last-hydrated-at + metadata) — harmless naming overlap.

---

## 11. Card rendering (`services/image.ts`)

satori → SVG → sharp → PNG (1200×630). `generatePnlCard` (symbol, side, leverage, entry/exit, ROI%, PnL, duration, size, optional referral QR badge) — win/lost background art. `generateWalletCard` (trader summary, best/worst). SpaceGrotesk fonts cached; backgrounds cached as data URIs; QR via `QRCode.toDataURL`. Shared as Telegram photo with `caption_entities`.

---

## 12. Server & ops (`src/server/*`)

Fastify: CORS `origin:false` (reject all), webhook route with secret-token check (`x-telegram-bot-api-secret-token` → 401 on mismatch), and `GET /health` (pings DB `SELECT 1` + Redis `PING`; 200 ok / 503 degraded). Logger is pino (pretty in dev, JSON in prod).

---

## 13. Testing

Vitest unit suites cover: `amount`, `errors`, `fmt`, `conditional`, `guardian` (+ evaluator/helpers), `lots`, `market`, `preflight`, `referral`, `image`, `action-log`, `trader-state-merge`, and bot flows (`trade-flow`, `tpsl-callbacks`, `guardian-callbacks`). Integration suites (separate config): `alerts`, `guardian`, `referral`. `scripts/check-numbers.sh` enforces the no-float-in-tx rule. Caveman communication style and number/UX standards are enforced via CLAUDE.md + `docs/`.

---

## 14. Notable design decisions & gotchas

1. **Bot-first custody** — wallets are app-owned (Privy authorization key); the bot signs without user interaction. Powerful but means the server holds signing authority.
2. **Float discipline is load-bearing** — tx amounts go string→`bigint`; floats only for display/analytics. There's a CI guard (`check:numbers`).
3. **WS traderState is price-blind** for liq price / per-symbol margin / risk tier — hence the parallel 20s REST refresh feeding the eval loop. (This was a prior Guardian bug class — see memory.)
4. **Flight routing guarded by pubkey length** to avoid proxy panic with stub keys; builder fee 10–15 bps taker-only.
5. **Two-source identity**: bot users (DB) vs discovered traders (GPA/WS) — leaderboard is independent and only links to a bot user when searched.
6. **Referral is points-only now** — USDC rebate columns retained for back-compat but unused; T2 tier enum retained, never inserted.
7. **Everything is one process** — convenient for dev, but a crash takes down bot + all feeds together (mitigated by supervised feeds + uncaughtException shutdown).
8. **Dedup is layered** — alert queue 5s, risk 300s, flip 60s, price 3600s, idempotency 120s, trade lock 150s, auto-action lock 150s.
9. **Zod v3/v4 bridge** in the trades feed because the Rise SDK ships v4 schemas while the app pins v3.

---

## 15. Directory cheat-sheet

```
src/
  main.ts                 boot/shutdown of all components
  config/                 Zod-validated env
  bot/
    index.ts              middleware chain + free-text/pending dispatcher
    commands/             18 commands + tpsl, testcard, log, status
    keyboards/            trade/position/market inline keyboards
    lib/                  errors, fmt, tx-flow, terms, pending, idempotent, paginate, validate, activation, referral-link
    middleware/           auth, rate-limit, action-log
  services/
    phoenix/              client, market, trade, conditional, position, preflight,
                          price-feed, market-stats-feed, trades-feed, feed-supervisor,
                          candles, lots, rest-limit
    wallet.ts referral.ts settings.ts trade-log.ts guardian.ts leaderboard.ts
    image.ts action-log.ts
  workers/
    ws.ts eval-loop.ts rest-refresh.ts trader-state-merge.ts leaderboard.ts
    evaluators/           guardian, risk-tier, monitor, position-flip, price-alert, shared
  jobs/                   queues.ts, processors/alert.ts
  db/                     schema/*, migrations/*, index.ts
  lib/                    amount, constants, privy, redis, rate-limiter, retry, logger
  server/                 Fastify + /health
docs/                     ~39 specs (Phoenix mechanics, UX/number standards, PRD)
tests/                    unit + integration (Vitest)
```

---

### TL;DR
SuperNova is a single-process TypeScript Telegram bot that turns Phoenix perps into a chat experience: Privy app-owned wallets, the Rise SDK for on-chain order/TP-SL/collateral flows with Jito-tipped Helius-sender dispatch, a Postgres+Drizzle data layer, and a Redis/BullMQ + Phoenix-WS real-time stack driving a 1 Hz risk-eval loop (Guardian auto-protection, risk-tier/monitor/price/flip alerts), plus a GPA-discovered leaderboard and points-based referral with shareable PnL/QR cards. Strict, enforced standards govern number precision, error handling, on-chain copy, and message formatting.
