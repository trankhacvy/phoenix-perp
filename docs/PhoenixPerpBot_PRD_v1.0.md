# 🔥 PhoenixPerpBot — Product Requirements Document

**Version:** 1.0 — MVP Draft  
**Status:** Draft  
**Date:** May 2026  
**Target Launch:** Q3 2026 (6–8 weeks)

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Users & Personas](#2-users--personas)
3. [Feature Requirements](#3-feature-requirements)
4. [Technical Architecture](#4-technical-architecture)
5. [Monetization & Economics](#5-monetization--economics)
6. [Build Phases & Milestones](#6-build-phases--milestones)
7. [Risks & Mitigations](#7-risks--mitigations)
8. [Open Questions & Dependencies](#8-open-questions--dependencies)

---

## 1. Product Overview

### 1.1 What is PhoenixPerpBot?

PhoenixPerpBot is a Telegram-native perpetual futures trading bot built on top of Phoenix Protocol — the fully onchain, CLOB-based perp DEX on Solana. It lets degens open, manage, and monitor leveraged positions directly from a Telegram chat with no app download, no browser, no seed phrases exposed.

The bot creates a custodial embedded wallet (via Privy) for every Telegram user, routes all trades through Phoenix's Flight builder program to earn builder fees, and layers a real-time alert system and copy-trading module on top to drive daily-active retention.

### 1.2 Problem

Telegram trading bots are a proven $16B+ category for spot tokens. For perpetual futures on Solana — a market with Drift ($400M OI), Jupiter Perps ($264B 2025 volume), and rising challengers like Pacifica — **no equivalent Telegram-first product exists**. Traders who want to quickly open or monitor a perp position must switch to a full desktop interface or mobile app.

Phoenix Protocol (by Ellipsis Labs, team behind $75B+ in Phoenix Spot volume) launched its perp product in private beta December 2025. It features sub-1 bps slippage on large trades, the cheapest base fees in the ecosystem (3.5 bps taker / 0.5 bps maker), and a fully documented Flight builder-code program that pays USDC fees to developers for every routed trade. The window for a first-mover Telegram product on Phoenix is open right now.

### 1.3 Solution

A single Telegram bot that covers the full trading lifecycle:

- **One-tap long/short** with embedded wallet (no seed phrase UX)
- **Live PnL panel, TP/SL**, and real-time liquidation alerts via WebSocket
- **Copy-trading:** follow a wallet from the Phoenix leaderboard, auto-mirror scaled trades
- **Viral PnL share cards** to drive organic growth on CT/TG
- **Multi-level referral** that stacks bot referral on top of Phoenix's native 20%/10% fee share

### 1.4 Product Vision

> *"The fastest way to trade Phoenix perps — from any Telegram chat, in under 30 seconds."*

### 1.5 Success Metrics (90 days post-launch)

| Metric | Target | Stretch |
|---|---|---|
| Daily Active Users | 200 | 500 |
| Daily Routed Volume | $500K | $2M |
| Monthly Builder Fee Revenue | $3K–5K USDC | $15K USDC |
| Copy-trade Followers | 50 | 200 |
| Referral Chain Depth | 2 levels | 3 levels |

---

## 2. Users & Personas

### 2.1 Primary — The Active Degen Trader

- **Profile:** Solana-native, trades perps 3–5x per week, active in CT and TG alpha groups
- **Pain:** Switching between Telegram and a full trading UI breaks flow; misses entries
- **Goal:** Execute a long/short thesis in <30s without opening a browser
- **Volume:** $5K–50K per trade; $100K–500K monthly notional

### 2.2 Secondary — The Copy Trader

- **Profile:** Follows whale wallets on Phoenix leaderboard; lacks time for original research
- **Pain:** Manual copy-trading is slow and error-prone; often enters after the move
- **Goal:** Auto-mirror a trusted trader with configurable size and risk limits
- **Volume:** Depends on leader; typically $10K–100K monthly routed notional

### 2.3 Tertiary — The Alert Watcher

- **Profile:** Passive observer or holder; wants to know when market moves hit key levels
- **Pain:** No lightweight mobile-friendly alert tool for Phoenix perp funding/price events
- **Goal:** Get notified on price alerts, funding flips, and near-liquidation warnings
- **Volume:** Low to zero direct trading; value is retention + conversion funnel

### 2.4 Non-Users (Out of Scope)

- US-based users (Phoenix is geo-restricted; bot must block US IPs and require attestation)
- Sanctioned jurisdictions (OFAC compliance required)
- Institutional / high-frequency market makers (not the Telegram use case)

---

## 3. Feature Requirements

### 3.1 Onboarding & Wallet `P0`

Every Telegram user gets a unique Privy embedded Solana wallet, created on first `/start`, no seed phrase shown by default (accessible via `/export` for advanced users). The bot activates the user's Phoenix account using the builder's access-code allocation via `POST /v1/invite/activate`. Onboarding must complete in under 30 seconds.

| Requirement | Detail |
|---|---|
| Wallet creation | Privy embedded wallet per Telegram `user_id`, deterministic |
| Deposit address | Show SOL + USDC deposit address with QR code on `/deposit` |
| Balance display | `/balance` shows USDC collateral on Phoenix + wallet SOL for gas |
| Withdraw | `/withdraw <amount> <address>` with 2-step confirm via inline button |
| Phoenix activation | Auto-activate with builder access code; no user friction |
| Key export | `/export` shows seed phrase after PIN confirmation; security warning shown |

### 3.2 Market Discovery `P0`

`/markets` lists all available Phoenix perp markets. Each entry shows: market name, mark price, 24h change %, 24h volume, funding APR, and open interest. Tapping a market opens a context menu with Quick Trade buttons.

| Requirement | Detail |
|---|---|
| `/markets` | Paginated list, real-time data from Phoenix REST market endpoint |
| `/price <symbol>` | Instant mark/oracle/mid price with funding rate and OI |
| `/funding` | Leaderboard of markets sorted by funding APR (highest payers first) |
| Market inline menu | From any market card: `[Long]` `[Short]` `[Alert]` `[Chart]` |

### 3.3 Trading — Open Position `P0`

The core trade flow. User selects market → side → leverage → size → confirms. All market orders are routed through `placeMarketOrder` with Flight builder config set. Default slippage tolerance: 0.5% with user-configurable override.

**Command syntax:** `/long <symbol> <leverage>x <size_usdc>`  
**Example:** `/long SOL 5x 100`

| Requirement | Detail |
|---|---|
| Market order | `placeMarketOrder` via Rise SDK with Flight builder config |
| Limit order | `placeLimitOrder` with price input via inline keyboard |
| Size presets | Inline buttons: `25%` / `50%` / `75%` / `100%` of free collateral |
| Leverage presets | Inline buttons: `2x` / `5x` / `10x` / `25x` |
| Confirmation screen | Show: entry price, fee, est. liquidation price — confirm or cancel |
| Stop-loss | `buildPlaceStopLoss` after fill confirmation; configurable at open |
| Take-profit | `buildLimitOrderPacket` on opposite side at TP price |
| Slippage | Default 0.5%; `/settings` lets user override to 0.1–2% |

### 3.4 Trading — Manage Positions `P0`

The `/positions` command shows a live panel with all open positions. Each position card auto-refreshes every 10 seconds via `traderState` WebSocket. One-tap close and partial-close are inline buttons on every card.

| Requirement | Detail |
|---|---|
| `/positions` | Live panel: market, side, size, entry, mark, unrealised PnL, liq price |
| Close position | Inline `[Close 100%]` button fires market order to close |
| Partial close | `[Close 25%/50%/75%]` inline buttons |
| Add margin | `[Add Margin]` button with USDC amount input |
| Edit SL/TP | `[Edit SL]` `[Edit TP]` from position card |
| `/history` | Paginated closed trade history with realised PnL per trade |
| `/pnl` | Summary: today / 7d / 30d / all-time realised + unrealised PnL |

### 3.5 Alerts `P0`

Alerts are the primary daily-active retention driver. The bot subscribes to `traderState` WebSocket per user and emits Telegram messages on critical events. All alert types are individually toggleable via `/alerts` settings.

| Alert Type | Trigger | Default |
|---|---|---|
| Fill notification | Order filled (full or partial) | ON |
| Liquidation warning | Margin ratio >80%, >90%, >95% | ON |
| Liquidation event | Position liquidated | ON |
| Price alert | User-set price crossed (any market) | Manual |
| Funding flip | Funding rate changes sign | OFF |
| Large funding | Funding APR exceeds ±50% | OFF |
| Copy-trade fill | Leader's trade mirrored for follower | ON |

### 3.6 Copy Trading `P1`

The copy-trading module is the primary organic growth lever. Users follow a wallet from the bot's internal leaderboard. When the leader opens or closes a position, the bot auto-replicates scaled trades for all followers.

Implementation: poll/subscribe to `traderState` WS for each leader wallet; diff position changes; fire scaled market/limit orders through follower's embedded wallet via Flight.

| Requirement | Detail |
|---|---|
| `/leaderboard` | Top 20 traders on Phoenix ranked by 7d ROI, win rate, sharpe |
| `/follow <wallet>` | Subscribe with configurable scale, max position, markets filter |
| `/unfollow <wallet>` | Stop mirroring; open positions stay open |
| `/following` | List active copy subscriptions with live P&L attribution |
| Scale factor | E.g. 10% means follower trades 10% of leader's size |
| Max position cap | Hard cap in USDC per market to prevent outsized exposure |
| Drawdown kill-switch | Auto-stop copy if leader drawdown exceeds user-set % |
| Market filter | Optionally only copy trades in selected markets |

### 3.7 PnL Share Cards `P1`

One-tap `/share` generates a Telegram-ready image card showing: market, side, entry/exit prices, ROI %, USD PnL, and the bot's Telegram username as referral handle. Degens share these organically on CT — this is the primary viral growth mechanism (modeled on Hyperliquid's share cards).

Generated as PNG via Satori + sharp (serverless, no headless browser needed).

### 3.8 Referral System `P1`

Every user gets a unique referral link. The bot operator's builder fee (10–15 bps via Flight) is the primary revenue stream. If Phoenix's native 20%/10% referral is combinable with Flight fees (confirm with Phoenix team), users who refer others earn a rebate from the operator's margin.

| Requirement | Detail |
|---|---|
| `/referral` | Shows unique link and lifetime referral stats |
| Tier 1 rebate | Operator shares X% of builder fee earned from T1 referrals |
| Tier 2 rebate | Operator shares Y% of builder fee earned from T2 referrals |
| Rebate payout | Accumulated USDC, claimable via `/claim` |
| Leaderboard | Public referral leaderboard to gamify top referrers |

---

## 4. Technical Architecture

### 4.1 Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Bot framework | grammY (TypeScript) | Better TS types than Telegraf; Bun-compatible; modern docs |
| Wallet infra | Privy (`@privy-io/node`) | Phoenix uses Privy; official Tg bot recipe exists; free <500 MAU |
| Phoenix SDK | `@ellipsis-labs/rise` | Official TS SDK with Flight wrapping built-in |
| RPC | Helius (paid tier) | Priority fee endpoint; reliable Solana submission at scale |
| Database | Supabase (Postgres) | User state, copy configs, PnL snapshots, alert subscriptions |
| Cache / queue | Upstash Redis + BullMQ | Alert dedup, copy-trade job queuing, WS subscription state |
| Image gen | Satori + sharp | PnL share card generation as PNG, no headless browser needed |
| Hosting | Railway (bot + workers) | Long-running WS workers need Railway; consistent with existing stack |
| Monitoring | Sentry + Telegram error channel | 95% of prod bugs are RPC/timeout issues; alert fast |

### 4.2 System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        Telegram API                             │
└─────────────────────┬───────────────────────────────────────────┘
                      │
              ┌───────▼────────┐
              │   Bot Process  │  grammY — handles commands
              │  (stateless)   │  routes to controllers
              └───────┬────────┘
                      │
        ┌─────────────┼──────────────┐
        │             │              │
┌───────▼──────┐ ┌────▼─────┐ ┌────▼──────────┐
│  WS Worker   │ │  Alert   │ │  Copy-Trade   │
│              │ │  Worker  │ │  Worker       │
│ traderState  │ │          │ │  (BullMQ)     │
│ subscriptions│ │ Redis    │ │               │
│ per user +   │ │ pub/sub  │ │ Scaled order  │
│ per leader   │ │ consumer │ │ execution     │
└──────┬───────┘ └──────────┘ └───────────────┘
       │
┌──────▼──────────────────────────────────────┐
│              Redis (Upstash)                │
│   Events / Alert rules / Job queues         │
└──────┬──────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────┐
│            Postgres (Supabase)              │
│  Users · Wallets · Positions · Copy configs │
│  Leaderboard cache · Referrals · PnL history│
└─────────────────────────────────────────────┘
```

**Leaderboard Indexer** — cron every 15 min; fetches Phoenix trader state snapshots for top-volume wallets; computes ROI, win rate, sharpe; writes to Postgres.

**Image Gen Service** — serverless function; accepts PnL data; renders PNG card via Satori; returns buffer.

### 4.3 Flight Integration

Every order instruction is wrapped through the Flight program by configuring the Rise SDK client with the builder authority:

```typescript
const client = await createPhoenixClient({
  flight: {
    builderAuthority: BUILDER_AUTHORITY_PUBKEY,
    builderPdaIndex: 0,
    builderSubaccountIndex: 0,
  }
});

// All orders below are auto-wrapped through Flight CPI
await client.ixs.placeMarketOrder({ ... });
await client.ixs.placeLimitOrder({ ... });
await client.ixs.buildPlaceStopLoss({ ... });
```

Builder fees accrue as USDC collateral on the builder trader account. Withdrawable from the Flight portal at any time. **Recommended initial builder fee: 10–15 bps** (confirm max/min with Phoenix team before launch).

### 4.4 Wallet Architecture & Security

> ⚠️ This is the single highest-risk component. Every major Tg bot incident (Banana Gun Sept 2023, Maestro Oct 2023, Unibot Oct 2023, Solareum April 2024) traced to wallet key management failures.

- Each user gets a Privy embedded wallet. The bot is registered as an **"additional authorized signer"** — enables the bot to submit transactions without per-trade user confirmation (matching Trojan/BonkBot UX)
- Bot's authorization key (Privy server-side signer) **MUST** be stored in cloud KMS (AWS KMS or GCP Cloud KMS) — never in env vars, never in DB
- **Policy engine:** per-wallet spending limits (max USDC per tx, max tx per hour) + allowlisted program IDs (Phoenix perp program only)
- **Withdrawal 2FA:** require inline button re-confirmation; 5-minute delay for first-time destination addresses
- **Security audit:** budget for OtterSec or Trail of Bits before crossing $5M/day routed volume

### 4.5 WebSocket Subscription Management

Phoenix WS channels in use:

| Channel | Purpose | Scope |
|---|---|---|
| `traderState` | Live position + PnL + fills | 1 per user with open position |
| `traderState` | Copy-trade leader monitoring | 1 per followed wallet |
| `allMids` | Price alert evaluation | 1 shared connection |
| `fundingRate` | Funding flip/spike alerts | 1 per market with active alert subs |

**Telegram rate limits:** 30 msgs/sec per bot, 1 msg/sec per user chat. Redis dedup window: 5 seconds minimum between duplicate alert types per user.

---

## 5. Monetization & Economics

### 5.1 Revenue Model

Primary revenue: Phoenix Flight builder fee (USDC, on-chain, withdrawable any time). No subscription. No token. Flat % of routed taker notional.

| Revenue Source | Detail |
|---|---|
| Flight builder fee | 10–15 bps on taker fills. Paid by user on top of Phoenix's 3.5 bps base. |
| Phoenix referral share *(conditional)* | 20%/10% T1/T2 of Phoenix base fees if combinable with Flight — confirm with team. |
| Copy-trade performance fee *(v2)* | 10% of realised PnL on copy positions — add post-PMF only. |

### 5.2 Unit Economics

| Monthly Routed Volume | Builder Fee @ 10 bps | Builder Fee @ 15 bps |
|---|---|---|
| $1M | $1,000 USDC | $1,500 USDC |
| $5M | $5,000 USDC | $7,500 USDC |
| $10M | $10,000 USDC | $15,000 USDC |
| $50M | $50,000 USDC | $75,000 USDC |

> **Pricing wedge:** Phoenix base taker fee is 3.5 bps. Adding 10–15 bps brings users to **4.5–5 bps all-in** — cheaper than Drift (10 bps default), comparable to Hyperliquid (4.5 bps), and ~20x cheaper than Trojan/BonkBot for spot (~100 bps).

### 5.3 User Fee Breakdown

| Fee Component | Rate | Recipient |
|---|---|---|
| Phoenix base taker fee | 3.5 bps | Phoenix Protocol |
| Phoenix base maker fee | 0.5 bps | Phoenix Protocol |
| PhoenixPerpBot builder fee | 10–15 bps (taker only) | Operator |
| Solana tx fee | ~0.001 SOL | Validators |
| **Total user cost (taker)** | **~4.5–5 bps + tiny SOL** | Split above |

---

## 6. Build Phases & Milestones

### Phase 1 — Trade & Alert Core (Weeks 1–4)

**Goal:** working bot where a user can deposit USDC, open/close a Phoenix perp position, and receive real-time liquidation alerts.

1. Setup: grammY bot scaffold, Privy server-side signer, Postgres schema (users, positions, alerts), Redis, Helius RPC
2. Wallet flows: `/start` creates Privy wallet + activates Phoenix account via invite API; `/deposit`, `/balance`, `/withdraw` with 2-step confirm
3. Trading: `/markets`, `/price`, `/long`, `/short` with size/leverage inline buttons, confirmation screen, Flight-wrapped `placeMarketOrder`
4. Position management: `/positions` live panel (10s refresh via `traderState` WS), inline close buttons, `/history`, `/pnl`
5. TP/SL: `/setsl`, `/settp` commands; `buildPlaceStopLoss` + opposite-side limit order
6. Alerts: `traderState` WS subscription per user; liquidation warnings at 80%/90%/95%; fill notifications; Redis dedup
7. Settings: `/settings` for slippage, leverage default, alert toggles
8. Internal QA: testnet dry-run with 5 internal test wallets; verify Flight fee accrual on devnet

### Phase 2 — Copy Trading + PnL Cards (Weeks 5–6)

**Goal:** add the two highest organic-growth features.

1. Leaderboard indexer: cron job fetching top Phoenix traders by volume; compute 7d ROI, win rate, sharpe from `traderState` snapshots
2. `/leaderboard` command: paginated top-20 with stats; tap to see full profile
3. `/follow` flow: scale factor, max position cap, drawdown kill-switch, market filter; store in Postgres
4. Copy-trade worker: BullMQ consumer; subscribe to leader `traderState` WS; diff positions; fire scaled orders via Flight; idempotent
5. `/following`: live panel showing all active copy subscriptions and P&L
6. PnL share card: Satori-based PNG generator; `/share` outputs card as Telegram photo; includes bot username as referral handle
7. Referral system: generate unique `/referral` link per user; track T1/T2 attribution in Postgres; `/claim` for accrued rebates

### Phase 3 — Harden & Launch (Weeks 7–8)

**Goal:** security hardening, monitoring, and public launch execution.

1. Security: KMS for bot signer key; policy engine (spending limits, allowlist); withdrawal delay for new addresses; internal pen test
2. Rate limiting: per-user command rate limits; Telegram message queue with backoff
3. Error handling: Sentry integration; Telegram ops channel for critical alerts; RPC fallback (Helius primary, QuickNode secondary)
4. Landing page *(optional)*: single-page Next.js site with `/start` CTA, key features, fee breakdown, referral leaderboard
5. Beta launch: seed with 20–50 users from Superteam Vietnam + Phoenix Discord
6. **Public launch trigger:** when Phoenix hits >$25M/24h volume (currently ~$8.6M)

---

## 7. Risks & Mitigations

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Custodial wallet exploit | 🔴 Critical | Medium | KMS for signer key; policy engine; spending limits; OtterSec audit at $5M/day |
| Phoenix private beta gate throttles growth | 🟠 High | High | Negotiate bulk access-code allocation with Phoenix team before launch; queue waitlist |
| Phoenix never scales past $25M/day | 🟠 High | Medium | Pivot plan: add Drift/Pacifica as additional venues using same bot infra |
| Trojan adds native Phoenix integration | 🟡 Medium | Medium | Win on focus and UX depth; Trojan is a generalist tool, not Phoenix-native |
| Phoenix mobile app cannibalizes bot | 🟡 Medium | Medium | Copy-trading and alerts have no mobile-app equivalent; double down on those |
| US regulatory exposure | 🟠 High | Low | Geo-block US IPs at signup; require jurisdiction attestation; no US-targeted marketing |
| Flight fee stacking ambiguity | 🟡 Medium | Low | Confirm combinability with Phoenix referral fees in writing before public launch |
| Solana congestion on high-volatility events | 🟡 Medium | High | Dynamic priority fee module; Helius + QuickNode dual RPC; user notification on failed tx |

---

## 8. Open Questions & Dependencies

These must be resolved before or shortly after development starts.

| # | Question | Action |
|---|---|---|
| 1 | What is the allowed min/max builder fee bps range for Flight? | Ask Phoenix team in Discord before setting fee |
| 2 | Can Flight builder fees and the native 20%/10% referral program be combined? | Get written confirmation; impacts referral rebate design |
| 3 | What is the access-code allocation process and cap for builders? | Apply to Flight program; negotiate bulk allocation before launch |
| 4 | Does Phoenix have a gasless tx sponsorship API for third-party builders? | Check docs/Discord; if no, implement own SOL fee-payer or require users to self-fund |
| 5 | Is the Rise SDK on npm and stable for production use? | Confirm `@ellipsis-labs/rise` npm version and changelog |
| 6 | What are the Phoenix devnet/testnet endpoints for development? | Ask in Discord; required for Phase 1 QA |
| 7 | Are there geographic/KYC requirements beyond self-attestation? | Review ToS; consult legal if US IP blocking is sufficient |

---

*PhoenixPerpBot PRD v1.0 — Confidential — May 2026*  
*Built on Phoenix Protocol · Powered by Ellipsis Labs*
