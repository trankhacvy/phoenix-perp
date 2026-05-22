# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This project uses **pnpm** as its package manager. Install with `brew install pnpm` if missing.

```bash
# Install dependencies
pnpm install

# Development (run each in a separate terminal)
pnpm dev                     # bot + webhook server (long-polling in dev)
pnpm dev:worker:ws           # WebSocket worker (Phoenix traderState subscriptions)
pnpm dev:worker:alert        # BullMQ alert dispatcher

# Build & type-check
pnpm build                   # tsc --noEmit then emit to dist/

# Lint & format
pnpm check                   # biome check (lint + format)
pnpm format                  # biome format --write

# Database
pnpm db:generate             # generate Drizzle migration from schema changes
pnpm db:migrate              # apply migrations
pnpm db:studio               # Drizzle Studio UI

# Tests
pnpm test                    # vitest run (single pass)
pnpm test:watch              # vitest in watch mode
pnpm test:coverage           # vitest with v8 coverage
```

To run a single test file: `pnpm exec vitest run tests/unit/services/referral.test.ts`

## Architecture

### Process model

Three independently deployed processes (Railway services):

| Process | Entry point | Role |
|---------|------------|------|
| Bot | `src/main.ts` | grammY bot + Fastify webhook server |
| WS worker | `src/workers/ws.ts` | Phoenix WS subscriptions, risk/fill detection |
| Alert worker | `src/workers/alert.ts` | BullMQ consumer, Telegram message dispatch |

The WS worker writes jobs to BullMQ (`alertQueue`). The alert worker processes them and calls `bot.api.sendMessage`. They never call each other directly.

### Bot request flow

```
Telegram → POST /webhook/<token>  (Fastify)
  → handleWebhook (grammY webhookCallback)
  → authMiddleware  (loads ctx.user from DB by telegramId)
  → rateLimitMiddleware  (Redis INCR, 20 req/min)
  → command handler
```

`ctx.user` is `undefined` for new users — `start.ts` handles onboarding. All other commands guard with `if (!ctx.user)`.

Multi-step flows (e.g., "enter margin amount") use Redis pending state: `pending:<telegramId>` → `action:symbol`. A free-text `bot.on("message:text")` handler in `src/bot/index.ts` dispatches based on this key.

### Phoenix integration

All Phoenix SDK code is in `src/services/phoenix/`. **The Rise SDK is not yet installed** — `client.ts` contains stubs that throw. The npm package name must be confirmed with Phoenix/Ellipsis Labs before any trade execution code can work.

Key facts:
- Phoenix USDC (`PhUsd...`) is distinct from standard USDC (`EPjFWdd5...`); all deposits/withdrawals go through the **Ember proxy contract** which wraps 1:1.
- Account PDA: `(wallet_authority, portfolio_index, subaccount_index)`. `subaccount_index=0` = cross-margin; `>0` = isolated.
- `ISOLATED_ONLY_MARKETS` in `src/services/phoenix/market.ts` — GOLD, SILVER, SKR, WTIOIL require an isolated subaccount.
- Builder fees (Flight): 10-15 bps taker-only. Builder activates users via `POST /v1/invite/activate` using `BUILDER_ACCESS_CODE` — users don't need their own codes.

### Wallet & identity

Privy creates a server-side embedded Solana wallet per user (`src/services/wallet.ts`). `telegramId` (string) is the primary key in the `users` table and the Privy linked account identifier.

### Alert pipeline

```
WS worker detects event → alertQueue.add(job)
Alert worker → dedup via Redis NX (5s window) → bot.api.sendMessage
```

Dedup key: `dedup:alert:<telegramId>:<type>`. Prevents duplicate alerts within 5 seconds for the same user+type.

### DB schema

Drizzle ORM with postgres.js. Schema files in `src/db/schema/`. All types use `$inferSelect` / `$inferInsert`. Key tables:
- `users` — telegram_id PK, privy wallet, phoenix activation status, bot-native referral code
- `alert_subscriptions` — per-user alert type toggles (pgEnum)
- `referrals` — bot-native T1/T2 chain; independent of Phoenix's native referral program (which requires $10K volume)

### ESM / import rules

`"type": "module"` + `"moduleResolution": "NodeNext"`. All imports must use `.js` extensions even for `.ts` source files. Never use CommonJS `require()`.

### Environment

`src/config/index.ts` validates all env vars via Zod at startup and crashes with field-level errors on failure. Required vars: `TELEGRAM_BOT_TOKEN`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `BUILDER_AUTHORITY_PUBKEY`, `BUILDER_ACCESS_CODE`, `HELIUS_RPC_URL`, `DATABASE_URL`, `REDIS_URL`. See schema in that file for all vars.

### Known bugs (unfixed — see plan.md Phase 0)

1. `src/bot/commands/alerts.ts` — alert toggle `findFirst` missing `type` filter
2. `src/bot/commands/deposit.ts` + `share.ts` — `replyWithPhoto` gets raw `Uint8Array`, needs `new InputFile(...)`
3. `src/bot/commands/long.ts` + `short.ts` — confirm callback regex `(\d+)` rejects decimals
4. `src/services/referral.ts` — T2 chain lookup can pick T2 row as parent; needs `eq(referrals.tier, "t1")` filter
5. `ws` / `@types/ws` not in `package.json` (imported in `src/workers/ws.ts`)
6. `vitest.config.ts` missing — tests won't run without it
7. `src/db/schema/settings.ts` missing — `userSettings` table referenced but not defined
