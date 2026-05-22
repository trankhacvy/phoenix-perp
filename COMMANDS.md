# Bot Commands

## Account

| Command | Description |
|---|---|
| `/start [code]` | Onboarding: jurisdiction attestation, Privy wallet creation, Phoenix activation. Pass a referral code to link it. Also handles deep links from `/positions`, `/history`, and `/markets`. |
| `/balance` | Deposited collateral, available margin, unrealized PnL, pending funding, SOL gas balance, wallet address, and risk tier. |
| `/deposit` | Wallet address + QR code. Send USDC and ~0.01 SOL for gas. |
| `/withdraw [amount]` | Withdraw USDC from the trading account. Two-step with a 5-minute security delay. |
| `/export` | Instructions for exporting your private key via the Privy dashboard. |

## Trading

| Command | Description |
|---|---|
| `/long [symbol] [leverage] [size]` | Open a long position. Run with no args for a guided flow (symbol → leverage → size → confirm), or pass all three inline for one-shot execution. |
| `/short [symbol] [leverage] [size]` | Open a short position. Same flow as `/long`. |
| `/positions` | All open positions with unrealized PnL, leverage, liquidation price. Tap a position for detail — close (25/50/100%), add margin, edit SL/TP. |
| `/markets` | Browse all markets paginated (5 per page) with price, funding APR, and max leverage. Tap a market row for full detail. |
| `/market <symbol>` | Mark price, OI, funding APR and direction, fees, and 1H technical indicators. Buttons to go long/short or set a price alert. |
| `/setsl <symbol>` | Set stop-loss. Choose from presets (−2% to −20%), enter a custom price, or toggle market/limit mode. |
| `/settp <symbol>` | Set take-profit. Choose from presets (+5% to +50%), enter a custom price, or set a ladder exit (25/50/100% closes). |

## History & Analytics

| Command | Description |
|---|---|
| `/history` | Paginated trade history (5 per page, last 30 trades). Each row shows size, fill price, and value (opens) or realized PnL (closes). Tap a row for full detail + Solscan link. |
| `/pnl` | Unrealized PnL summary across all open positions plus pending funding. |
| `/portfolio` | Full account snapshot — balance + all open positions in one view. |
| `/share <symbol>` | Generate a shareable PnL card image (PNG) for a closed position. |

## Referral

| Command | Description |
|---|---|
| `/referral` | Your referral link, T1/T2 counts, total accrued USDC, and claimable balance. |
| `/claim` | Claim accrued referral rebate (minimum $1). |

## Alerts

| Command | Description |
|---|---|
| `/alerts` | Toggle alert types on/off: at-risk, cancellable, liquidatable, fill, TP/SL flip, funding flip, large funding. |
| `/alert <symbol>` | Set a price alert for a market. Fires once when price crosses your target (above or below current price). |

## Settings

| Command | Description |
|---|---|
| `/settings` | Default slippage (0.1%–2%) and default leverage (2x–50x). |
| `/funding` | Top 10 markets by funding rate magnitude with direction and APR. |
