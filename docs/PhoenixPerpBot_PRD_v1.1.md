# 🔥 PhoenixPerpBot — Product Requirements Document

**Version:** 1.1 — MVP Draft (Updated)
**Status:** Draft
**Date:** May 2026
**Target Launch:** Q3 2026 (6–8 weeks)

**Changelog v1.1:**
- Removed copy trading (§3.6) — moved to v3 roadmap; no Phoenix leaderboard API exists
- Removed dependency on Phoenix native referral codes; bot-native referral only
- Updated onboarding to reflect Ember proxy contract, withdrawal queue, access-code-only activation
- Updated alerts to use Phoenix risk tier names instead of arbitrary margin %
- Updated trading to reflect dynamic leverage tiers, isolated-only markets, TP/SL execution details
- Updated positions panel to reflect uPnL discount and TP/SL flip invalidation
- Removed commodities (GOLD, SILVER, WTIOIL, SKR) from default supported markets; isolated-only support conditional
- Added Flight SDK beta caveat throughout
- Updated market count (29+ markets)
- Adjusted build phases accordingly

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

The bot creates a custodial embedded wallet (via Privy) for every Telegram user, routes all trades through Phoenix's Flight builder program to earn builder fees, and layers a real-time alert system on top to drive daily-active retention.

> **Note:** Both PhoenixPerpBot and the Phoenix Flight SDK are in beta. The bot will be launched as a beta product alongside Phoenix's own beta phase.

### 1.2 Problem

Telegram trading bots are a proven $16B+ category for spot tokens. For perpetual futures on Solana — a market with Drift ($400M OI), Jupiter Perps ($264B 2025 volume), and rising challengers like Pacifica — **no equivalent Telegram-first product exists**. Traders who want to quickly open or monitor a perp position must switch to a full desktop interface or mobile app.

Phoenix Protocol (by Ellipsis Labs, team behind $75B+ in Phoenix Spot volume) launched its perp product in private beta December 2025. It features sub-1 bps slippage on large trades, the cheapest base fees in the ecosystem (3.5 bps taker / 0.5 bps maker), and a fully documented Flight builder-code program that pays USDC fees to developers for every routed trade. The window for a first-mover Telegram product on Phoenix is open right now.

### 1.3 Solution

A single Telegram bot that covers the full trading lifecycle:

- **One-tap long/short** with embedded wallet (no seed phrase UX)
- **Live PnL panel, TP/SL**, and real-time liquidation alerts via WebSocket
- **Viral PnL share cards** to drive organic growth on CT/TG
- **Bot-native referral system** that earns rebates from the operator's builder fee margin

> Copy trading is planned for v3 after Phoenix stabilizes its data APIs.

### 1.4 Product Vision

> *"The fastest way to trade Phoenix perps — from any Telegram chat, in under 30 seconds."*

### 1.5 Success Metrics (90 days post-launch)

| Metric | Target | Stretch |
|---|---|---|
| Daily Active Users | 200 | 500 |
| Daily Routed Volume | $500K | $2M |
| Monthly Builder Fee Revenue | $3K–5K USDC | $15K USDC |
| Referral Chain Depth | 2 levels | 3 levels |

---

## 2. Users & Personas

### 2.1 Primary — The Active Degen Trader

- **Profile:** Solana-native, trades perps 3–5x per week, active in CT and TG alpha groups
- **Pain:** Switching between Telegram and a full trading UI breaks flow; misses entries
- **Goal:** Execute a long/short thesis in <30s without opening a browser
- **Volume:** $5K–50K per trade; $100K–500K monthly notional

### 2.2 Secondary — The Alert Watcher

- **Profile:** Passive observer or holder; wants to know when market moves hit key levels
- **Pain:** No lightweight mobile-friendly alert tool for Phoenix perp funding/price events
- **Goal:** Get notified on price alerts, funding flips, and near-liquidation warnings
- **Volume:** Low to zero direct trading; value is retention + conversion funnel

### 2.3 Non-Users (Out of Scope)

- US-based users (Phoenix is geo-restricted; bot must block US IPs and require attestation)
- Sanctioned jurisdictions (OFAC compliance required)
- Institutional / high-frequency market makers (not the Telegram use case)

---

## 3. Feature Requirements

### 3.1 Onboarding & Wallet `P0`

Every Telegram user gets a unique Privy embedded Solana wallet, created on first `/start`, no seed phrase shown by default (accessible via `/export` for advanced users). The bot activates the user's Phoenix account on their behalf using the builder's access-code allocation via `POST /v1/invite/activate`. Onboarding must complete in under 30 seconds.

**Collateral model:** Phoenix uses a dual-USDC system. Standard Solana USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) is wrapped 1:1 by the **Ember** proxy contract (`EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy`) into Phoenix USDC (`PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A`) on deposit. Withdrawals reverse the conversion atomically. No exchange rate or haircut is applied. The bot must use the correct mint addresses when building deposit/withdraw transactions.

| Requirement | Detail |
|---|---|
| Wallet creation | Privy embedded wallet per Telegram `user_id`, deterministic |
| Deposit address | Show SOL + USDC deposit address with QR code on `/deposit` |
| Balance display | `/balance` shows Phoenix USDC collateral on account + wallet SOL for gas. Note: two different USDC mints — wallet balance vs. Phoenix collateral balance must be clearly distinguished |
| Withdraw | `/withdraw <amount> <address>` with 2-step confirm via inline button. Withdrawals go through the Ember unwrap path. Phoenix enforces a **global withdrawal queue** (budget: 2M USDC, replenishes at 450 USDC/slot) — large withdrawals may be queued. Bot must show pending queue status and not report failure if queued |
| Phoenix activation | Auto-activate with builder access code via `POST /v1/invite/activate`; no user friction. Builder must negotiate bulk access-code allocation with Phoenix team |
| Key export | `/export` shows seed phrase after PIN confirmation; security warning shown |

### 3.2 Market Discovery `P0`

`/markets` lists available Phoenix perp markets. Phoenix currently has 29+ markets including SOL, BTC, ETH, and many long-tail tokens. Each entry shows: market name, mark price, 24h change %, 24h volume, funding APR, open interest, and margin mode (cross or isolated-only). Tapping a market opens a context menu with Quick Trade buttons.

**Default supported markets (cross-margin only, MVP):** SOL, BTC, ETH, and major alts. Isolated-only markets (GOLD, SILVER, SKR, WTIOIL) are displayed but gated behind a `[Isolated — Advanced]` label; full support is conditional (see §3.3).

| Requirement | Detail |
|---|---|
| `/markets` | Paginated list with search, real-time data from Phoenix REST market endpoint. Shows margin mode badge per market |
| `/price <symbol>` | Instant mark/oracle/mid price with funding rate and OI |
| `/funding` | Leaderboard of markets sorted by funding APR (highest payers first) |
| Market inline menu | From any market card: `[Long]` `[Short]` `[Alert]` `[Chart]` |

### 3.3 Trading — Open Position `P0`

The core trade flow. User selects market → side → leverage → size → confirms. All market orders are routed through `placeMarketOrder` with Flight builder config set.

**Command syntax:** `/long <symbol> <leverage>x <size_usdc>`
**Example:** `/long SOL 5x 100`

**Leverage tiers:** Phoenix uses market-specific, size-based leverage tiers. Max leverage decreases as position size increases. Leverage preset buttons must be dynamically capped per market and per entered size — static `25x` buttons are not valid for all markets or all sizes. Confirm available tiers via `exchange().getMarket(symbol)` at order time.

**Isolated-only markets (GOLD, SILVER, SKR, WTIOIL):** These markets require an isolated subaccount (`subaccount_index > 0`). Cross-margin is not supported. Opening a position in these markets requires: creating an isolated subaccount PDA, transferring collateral from cross account to isolated account. Closing the position triggers a crank to sweep remaining collateral back to cross account. This flow is implemented as a conditional feature behind a market flag.

**Default slippage tolerance:** 0.5% with user-configurable override.

| Requirement | Detail |
|---|---|
| Market order | `placeMarketOrder` via Rise SDK with Flight builder config |
| Limit order | `placeLimitOrder` with price input via inline keyboard |
| Size presets | Inline buttons: `25%` / `50%` / `75%` / `100%` of free collateral |
| Leverage presets | Dynamic inline buttons capped to market's max leverage at entered size. Fetched from market config |
| Confirmation screen | Show: entry price (estimated), fee breakdown (Phoenix base fee + builder fee), estimated liquidation price, slippage tolerance — confirm or cancel |
| Stop-loss | `buildPlaceStopLoss` after fill confirmation; configurable at open. SL in Market mode uses IOC with **10% slippage buffer** around trigger price — warn user in confirmation |
| Take-profit | `buildLimitOrderPacket` on opposite side at TP price |
| Slippage | Default 0.5%; `/settings` lets user override to 0.1–2% |
| Isolated markets | Conditional support for GOLD, SILVER, SKR, WTIOIL behind market flag |

### 3.4 Trading — Manage Positions `P0`

The `/positions` command shows a live panel with all open positions. Each position card auto-refreshes every 10 seconds via `traderState` WebSocket subscription.

**Effective collateral note:** Phoenix discounts positive unrealized PnL before counting it toward margin (market-specific `uPnL risk factor`). The displayed effective collateral and liquidation price use discounted uPnL — the bot must use the same calculation, not raw `deposited_collateral + unrealized_pnl`. Liquidation price can shift even if the user has not touched that market (cross-margin effects from other positions, funding accrual, mark price changes).

**TP/SL position flip:** If a position flips direction (e.g., net long becomes net short), **all active TP/SL orders on that market are automatically invalidated by the protocol**. The bot must detect this via the WebSocket, notify the user, and prompt them to reattach TP/SL.

| Requirement | Detail |
|---|---|
| `/positions` | Live panel: market, side, size, entry price, mark price, unrealized PnL, effective collateral (discounted), estimated liq price, margin mode (cross/isolated) |
| Close position | Inline `[Close 100%]` button fires market order to close |
| Partial close | `[Close 25%/50%/75%]` inline buttons |
| Add margin | `[Add Margin]` button with USDC amount input. For isolated positions: transfers from cross account to isolated subaccount |
| Edit SL/TP | `[Edit SL]` `[Edit TP]` from position card |
| TP/SL flip alert | Bot detects position flip via WS and sends alert: "Your TP/SL for [market] was cancelled — position flipped. Reattach?" |
| `/history` | Paginated closed trade history with realised PnL per trade |
| `/pnl` | Summary: today / 7d / 30d / all-time realised + unrealised PnL |

### 3.5 Alerts `P0`

Alerts are the primary daily-active retention driver. The bot subscribes to `traderState` WebSocket per user and emits Telegram messages on critical events. All alert types are individually toggleable via `/alerts` settings.

**Risk tier mapping:** Phoenix expresses account health via named risk tiers, not a simple margin ratio percentage. The bot maps these tiers to alert levels:

| Phoenix Risk Tier | Meaning | Alert Severity |
|---|---|---|
| `AtRisk` | Below initial margin, above cancel margin | ⚠️ Warning |
| `Cancellable` | Risk-increasing orders may be force-cancelled | 🟠 Danger |
| `Liquidatable` | Market liquidation can begin | 🔴 Critical |
| `BackstopLiquidatable` | Beyond normal liquidation | 🆘 Emergency |
| `HighRisk` | ADL eligible | 🆘 Emergency |

| Alert Type | Trigger | Default |
|---|---|---|
| Fill notification | Order filled (full or partial) | ON |
| AtRisk warning | Account enters `AtRisk` tier | ON |
| Cancellable warning | Account enters `Cancellable` tier | ON |
| Liquidation warning | Account enters `Liquidatable` tier | ON |
| Liquidation event | Position liquidated | ON |
| TP/SL flip | Position flipped, TP/SL invalidated | ON |
| Price alert | User-set price crossed (any market) | Manual |
| Funding flip | Funding rate changes sign | OFF |
| Large funding | Funding APR exceeds ±50% (check per market cap) | OFF |

### 3.6 PnL Share Cards `P1`

One-tap `/share` generates a Telegram-ready image card showing: market, side, entry/exit prices, ROI %, USD PnL, and the bot's Telegram username as referral handle. Degens share these organically on CT — this is the primary viral growth mechanism (modeled on Hyperliquid's share cards).

Generated as PNG via Satori + sharp (serverless, no headless browser needed).

### 3.7 Referral System `P1`

Every user gets a unique bot-native referral link. This is **entirely separate from Phoenix's native referral program** (which requires $10K lifetime volume and limited code slots). The bot tracks referrals internally and distributes rebates from the operator's builder fee margin.

> Phoenix's native referral program (20%/10% fee share for referrers, 10% fee discount for referees) is NOT used in this bot. It is a Phoenix-frontend-only feature with a $10K volume gate. The bot's referral system is operator-managed, funded by the builder fee.

| Requirement | Detail |
|---|---|
| `/referral` | Shows unique bot-native referral link and lifetime referral stats |
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
| Phoenix SDK | Rise SDK (TypeScript) | Official TS SDK with Flight wrapping. **Flight integration is currently in beta** — treat as unstable until Phoenix confirms stable release |
| RPC | Helius (paid tier) | Priority fee endpoint; reliable Solana submission at scale |
| Database | Supabase (Postgres) | User state, PnL snapshots, alert subscriptions, referrals |
| Cache / queue | Upstash Redis + BullMQ | Alert dedup, WS subscription state, job queuing |
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
│  WS Worker   │ │  Alert   │ │  Image Gen    │
│              │ │  Worker  │ │  Worker       │
│ traderState  │ │          │ │  (Satori)     │
│ subscriptions│ │ Redis    │ │               │
│ per user     │ │ pub/sub  │ │ PnL share     │
│              │ │ consumer │ │ card PNG      │
└──────┬───────┘ └──────────┘ └───────────────┘
       │
┌──────▼──────────────────────────────────────┐
│              Redis (Upstash)                │
│   Events / Alert rules / Job queues         │
└──────┬──────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────┐
│            Postgres (Supabase)              │
│  Users · Wallets · Positions · Referrals   │
│  PnL history · Alert subscriptions         │
└─────────────────────────────────────────────┘
```

### 4.3 Flight Integration

> ⚠️ **Flight support in Rise is currently in beta and should not yet be treated as a stable production surface.** Monitor Rise SDK changelog for stable release. The bot will launch in beta with Flight and upgrade when stable.

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

**Flight fee scope:** Builder fees are charged only on **liquidity-removing fills** (market orders + the taking portion of a limit order). Maker-side fee collection is on Phoenix's roadmap but not available today.

Builder fees accrue as USDC collateral on the builder trader account. Withdrawable from the Flight portal at any time. **Recommended initial builder fee: 10–15 bps** (confirm min/max range with Phoenix team before launch).

**Builder registration:** Registration is an on-chain instruction, not a web form. Use a fresh, empty wallet for the builder authority to keep builder revenue isolated from trading collateral.

### 4.4 Wallet Architecture & Security

> ⚠️ This is the single highest-risk component. Every major Tg bot incident (Banana Gun Sept 2023, Maestro Oct 2023, Unibot Oct 2023, Solareum April 2024) traced to wallet key management failures.

- Each user gets a Privy embedded wallet. The bot is registered as an **"additional authorized signer"** — enables the bot to submit transactions without per-trade user confirmation (matching Trojan/BonkBot UX)
- Bot's authorization key (Privy server-side signer) **MUST** be stored in cloud KMS (AWS KMS or GCP Cloud KMS) — never in env vars, never in DB
- **Policy engine:** per-wallet spending limits (max USDC per tx, max tx per hour) + allowlisted program IDs (Phoenix perp program + Ember contract only)
- **Withdrawal 2FA:** require inline button re-confirmation; 5-minute delay for first-time destination addresses; surface withdrawal queue status if queued
- **Security audit:** budget for OtterSec or Trail of Bits before crossing $5M/day routed volume

### 4.5 WebSocket Subscription Management

Phoenix WS endpoint: `wss://perp-api.phoenix.trade/v1/ws`

Channels in use (verify exact channel names against Phoenix WS protocol docs):

| Channel | Purpose | Scope |
|---|---|---|
| `traderState` | Live position + PnL + fills + risk tier | 1 per user with open position |
| `allMids` | Price alert evaluation | 1 shared connection |
| `fundingRate` | Funding flip/spike alerts | 1 per market with active alert subs |

**Risk tier parsing:** The `traderState` payload includes account risk tier. Map tier transitions (`AtRisk`, `Cancellable`, `Liquidatable`, `BackstopLiquidatable`, `HighRisk`) to the alert levels defined in §3.5. Do not compute margin ratios manually.

**Telegram rate limits:** 30 msgs/sec per bot, 1 msg/sec per user chat. Redis dedup window: 5 seconds minimum between duplicate alert types per user.

### 4.6 Account & Margin Model

Phoenix separates wallet authority from trader accounts. Key facts the bot must handle:

- Each trader account is a PDA derived from `(wallet_authority, portfolio_index, subaccount_index)`
- `subaccount_index = 0` = cross account (shared collateral pool, up to 128 positions)
- `subaccount_index > 0` = isolated account (dedicated collateral, single position)
- Isolated-only markets (GOLD, SILVER, SKR, WTIOIL) require `subaccount_index > 0`
- Closing an isolated position → crank sweeps collateral back to cross account
- **Effective collateral** = `deposited_collateral + discounted_positive_uPnL + negative_uPnL + unsettled_funding` — positive uPnL is discounted by market-specific risk factor, negative uPnL counts in full
- Funding settles every 24 hours but unsettled funding affects account health in real-time

---

## 5. Monetization & Economics

### 5.1 Revenue Model

Primary revenue: Phoenix Flight builder fee (USDC, on-chain, withdrawable any time). No subscription. No token. Flat % of routed taker notional.

| Revenue Source | Detail |
|---|---|
| Flight builder fee | 10–15 bps on taker fills only. Paid by user on top of Phoenix's 3.5 bps base. Maker fills do not generate builder fee (yet). |
| Copy-trade performance fee *(v3)* | 10% of realised PnL on copy positions — add post-PMF only. |

> Phoenix's native referral 20%/10% program is NOT part of the bot's revenue model. It requires $10K user volume to unlock and is gated to the Phoenix frontend.

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

1. Setup: grammY bot scaffold, Privy server-side signer, Postgres schema (users, positions, alerts, referrals), Redis, Helius RPC
2. Wallet flows: `/start` creates Privy wallet + activates Phoenix account via `POST /v1/invite/activate` with builder access code; `/deposit` (routes through Ember contract), `/balance` (shows both wallet USDC and Phoenix collateral), `/withdraw` with 2-step confirm + withdrawal queue status
3. Trading: `/markets` (29+ markets, paginated, margin mode badge), `/price`, `/long`, `/short` with dynamic leverage/size inline buttons, confirmation screen, Flight-wrapped `placeMarketOrder`
4. Position management: `/positions` live panel (10s refresh via `traderState` WS), inline close buttons, effective collateral (discounted uPnL), estimated liq price, `/history`, `/pnl`
5. TP/SL: `/setsl`, `/settp` commands; `buildPlaceStopLoss` (warn: Market mode has 10% slippage buffer) + opposite-side limit order for TP; position flip invalidation detection + alert
6. Alerts: `traderState` WS subscription per user; risk tier transition alerts (`AtRisk` → `Cancellable` → `Liquidatable`); fill notifications; TP/SL flip notifications; Redis dedup
7. Settings: `/settings` for slippage, leverage default, alert toggles
8. Internal QA: dry-run with 5 internal test wallets; verify Flight fee accrual; verify Ember deposit/withdraw round-trip; verify withdrawal queue handling

### Phase 2 — PnL Cards + Referral (Weeks 5–6)

**Goal:** add the two primary organic-growth features.

1. PnL share card: Satori-based PNG generator; `/share` outputs card as Telegram photo; includes bot username as referral handle
2. Referral system: generate unique bot-native `/referral` link per user; track T1/T2 attribution in Postgres; accumulate rebate from operator builder fee margin; `/claim` for accrued rebates; public referral leaderboard
3. Isolated margin support (conditional): implement isolated subaccount flow for GOLD, SILVER, SKR, WTIOIL; collateral transfer + post-close sweep; isolated position display in `/positions`

### Phase 3 — Harden & Launch (Weeks 7–8)

**Goal:** security hardening, monitoring, and public launch execution.

1. Security: KMS for bot signer key; policy engine (spending limits, Phoenix perp + Ember allowlist only); withdrawal delay for new addresses; internal pen test
2. Rate limiting: per-user command rate limits; Telegram message queue with backoff
3. Error handling: Sentry integration; Telegram ops channel for critical alerts; RPC fallback (Helius primary, QuickNode secondary)
4. Landing page *(optional)*: single-page Next.js site with `/start` CTA, key features, fee breakdown, referral leaderboard
5. Beta launch: seed with 20–50 users from Superteam Vietnam + Phoenix Discord
6. **Public launch trigger:** when Phoenix hits >$25M/24h volume (currently ~$8.6M)

### Future — v3 Roadmap

- **Copy trading:** blocked on Phoenix exposing a trader discovery / leaderboard API. Track Phoenix API changelog. When available: leaderboard indexer, `/follow`, `/leaderboard`, copy-trade worker.
- **Phoenix native referral integration:** when Phoenix referral becomes accessible to builder-activated users without the $10K volume gate.
- **Maker order rebate via Flight:** when Phoenix enables Flight builder fees on maker fills.

---

## 7. Risks & Mitigations

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Custodial wallet exploit | 🔴 Critical | Medium | KMS for signer key; policy engine; spending limits; OtterSec audit at $5M/day |
| Flight SDK breaks in beta | 🔴 Critical | Medium | Monitor Rise SDK releases; have fallback to non-Flight order routing; bot launched as beta |
| Phoenix access-code allocation insufficient | 🟠 High | High | Negotiate bulk allocation before launch; build waitlist queue if codes run out |
| Phoenix never scales past $25M/day | 🟠 High | Medium | Pivot plan: add Drift/Pacifica as additional venues using same bot infra |
| Phoenix private beta gate throttles growth | 🟠 High | High | Bot is also beta; grow together with Phoenix |
| Trojan adds native Phoenix integration | 🟡 Medium | Medium | Win on UX depth; Trojan is a generalist tool, not Phoenix-native |
| Phoenix mobile app cannibalizes bot | 🟡 Medium | Medium | Alerts and share cards have no mobile-app equivalent; double down on those |
| US regulatory exposure | 🟠 High | Low | Geo-block US IPs at signup; require jurisdiction attestation; no US-targeted marketing |
| Flight fee stacking ambiguity | 🟡 Medium | Low | Confirm min/max bps range in writing before public launch |
| Solana congestion on high-volatility events | 🟡 Medium | High | Dynamic priority fee module; Helius + QuickNode dual RPC; user notification on failed tx |
| Withdrawal queue surprises users | 🟡 Medium | Medium | Surface queue status in bot; set expectation in `/withdraw` confirmation message |

---

## 8. Open Questions & Dependencies

These must be resolved before or shortly after development starts.

| # | Question | Action |
|---|---|---|
| 1 | What is the allowed min/max builder fee bps range for Flight? | Ask Phoenix team in Discord before setting fee |
| 2 | What is the access-code allocation process and cap for builders? How many users can one code activate? | Apply to Flight program; negotiate bulk allocation before launch |
| 3 | Does Phoenix have a gasless tx sponsorship API for third-party builders? | Check docs/Discord; if no, implement own SOL fee-payer or require users to self-fund SOL for gas |
| 4 | What is the Rise SDK npm package name and is it published on npm? | Confirm `@ellipsis-labs/rise` (or correct name) from Phoenix team / GitHub |
| 5 | What are the exact WebSocket channel names for `traderState`, `allMids`, `fundingRate`? | Review Phoenix WS protocol docs; confirm against live WS |
| 6 | What are the Phoenix devnet/testnet endpoints for development? | Ask in Discord; required for Phase 1 QA |
| 7 | Are there geographic/KYC requirements beyond self-attestation? | Review ToS; consult legal if US IP blocking is sufficient |
| 8 | When will Flight SDK be marked stable? | Monitor Rise SDK changelog; ask Ellipsis Labs team |
| 9 | Is there any Phoenix API for trader discovery / top-volume wallets (needed for future copy-trading)? | Ask Phoenix team; track API changelog for v3 roadmap |

---

*PhoenixPerpBot PRD v1.1 — Confidential — May 2026*
*Built on Phoenix Protocol · Powered by Ellipsis Labs*
