# Bot Commands

## Account

| Command | Description |
|---|---|
| `/start [code]` | Onboarding: creates Privy wallet, generates referral code. Pass a referral code to link it. Existing users see a dashboard with wallet balance + navigation. Also handles deep links for positions, history, markets, wallets, and trades. |
| `/activate [code]` | Activate Phoenix trading account using an invite code or referral code. Tries invite activation first, falls back to referral activation. Required before trading. |
| `/portfolio` | Full account snapshot — wallet USDC balance, trading account collateral, available margin, total value, open P&L (unrealized + pending funding), inline positions (up to 5), SOL gas balance, and risk tier. Surfaces idle USDC with "Add Collateral" shortcut. |
| `/deposit` | Two-step deposit flow: (1) shows wallet address + QR code to receive USDC, (2) moves wallet USDC into Phoenix trading account as collateral. Supports "all" or custom amount. |
| `/withdraw` | Withdraw USDC from the trading account. Choose destination: **bot wallet** (single tx, instant) or **external wallet** (two tx — Phoenix→bot wallet→address, needs ~0.001 SOL gas). Shows safe-to-withdraw amount vs max. Percentage presets or custom amount. Double-submit protection via Redis locks. |
| `/settings` | Configure default slippage tolerance (0.1%–2%) and default leverage (2x–50x). |

## Trading

| Command | Description |
|---|---|
| `/long [symbol] [leverage] [size]` | Open a long position. No args → guided flow: symbol picker → size step (% of balance or custom) → leverage step → confirm with full quote. Or pass all three inline (e.g., `/long SOL 10x 500`) for one-shot execution. Preflight validates activation, collateral, leverage tiers, and price drift. |
| `/short [symbol] [leverage] [size]` | Open a short position. Same flow as `/long`. |
| `/positions` | List all open positions with unrealized PnL, leverage, liquidation price. Tap a position for detail view — close (25/50/100%), add margin, set SL/TP, refresh. Generates PnL card on close. |
| `/markets` | Browse all markets paginated (10 per page) with price, funding rate APR + trend, and max leverage. Tap a market for full detail. |
| `/market <symbol>` | Market detail: mark price, open interest, funding rate (APR, direction, daily cost per $10K, trend arrows), taker fee, leverage tiers. 1H technical indicators: RSI(14), MACD, Bollinger Bands, ATR(14). Commodity market hours noted when applicable. Buttons to go long/short or set a price alert. |
| (TP/SL via position detail) | Set or manage take-profit / stop-loss from `/positions` → tap position → "🎯 Set TP" / "🛑 Set SL" buttons. Each opens a per-leg manager supporting ladder (multiple levels), per-rung edit (price/size/mode), atomic single-tx submits. Standalone `/setsl` and `/settp` commands removed. |

## History & Analytics

| Command | Description |
|---|---|
| `/history` | Paginated trade history (5 per page, last 30 fills). Each row shows action type (Open Long, Close Short, SL, TP), size, fill price, and value (opens) or realized PnL (closes) with timestamps. Tap a row for full detail + Solscan link. |
| `/share <symbol>` | Generate a shareable PnL card image (PNG) for the most recent closed trade on a symbol. Card shows market, side, entry/exit price, ROI%, and realized PnL with themed background. |
| `/wallet <address>` | Look up any Solana wallet's Phoenix activity. Shows full address (copyable), portfolio, live positions (up to 5) with Copy/Counter deep links, all-time stats (PnL, win rate, volume, long/short ratio, maker %), best/worst trade, per-market breakdown. Buttons: Follow trader, trade history, generate wallet card. |

## Leaderboard

| Command | Description |
|---|---|
| `/leaderboard` | Top traders ranked by volume, win rate, or realized PnL (sortable). Paginated with 10 per page. Named wallets from `wallet-tags.json` show display names. Tap a trader for their full profile via `/wallet`. |

## Referral

| Command | Description |
|---|---|
| `/referral` | Your referral link, T1/T2 referral counts, total accrued USDC rebate, and claimable balance. Referral system is bot-native (independent of Phoenix's $10K volume requirement). T1 = 20% of builder fee, T2 = 10%. |
| `/claim` | Claim accrued referral rebate (minimum $1 USDC). |

## Alerts & Monitoring

| Command | Description |
|---|---|
| `/alerts` | Toggle alert types on/off: fill, at-risk, cancellable, liquidatable, TP/SL flip, funding direction change, high funding rate. |
| `/alert <symbol> [price]` | Set a price alert. Fires once when price crosses your target. Detects above/below based on current mark price. Deduped for 1 hour. |
| `/monitor [address]` | Watch up to 10 external wallets. Get alerts when they open, close, flip, or fill positions — with Copy/Counter trade buttons and trader profile link. No args shows your monitored list with remove buttons. |
| `/funding` | Top 10 markets by funding rate magnitude with direction (longs pay / shorts pay) and rate percentage. |

## Dev / Admin

| Command | Description |
|---|---|
| `/exportkey` | **Dev only.** Export your Privy wallet private key (base58). Prompts for confirmation. Not registered in production. |
| `/log [user_id]` | **Admin only.** Show last 10 action log entries for a user. Gated by `ADMIN_TELEGRAM_IDS` env var. |
| `/status` | **Dev only.** Preview all 9 alert message formats with live inline keyboards. Not registered in production. |
