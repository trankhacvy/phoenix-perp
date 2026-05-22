# Trading UX Flows — Phoenix Perp Bot

> **Scope:** All trading-related flows. Each section defines exact message text, button layouts, validation rules, and edge cases.

---

## Design Conventions

### Number Formatting

| Type | Format | Example |
|---|---|---|
| USD prices (large) | `$X,XXX.XX` | `$49,850.00` |
| USD prices (small) | `$X.XXXX` | `$0.0421` |
| USD amounts | `$X,XXX.XX` | `$1,247.50` |
| Percentages | `+X.XX%` / `-X.XX%` | `+2.41%` |
| Leverage | `Xx` | `10x` |
| Funding APR | `+X.XX% / yr` | `+18.24% / yr` |
| Crypto size | `X.XXXX SYMBOL` | `0.0250 BTC` |
| Large crypto | `X.XX SYMBOL` | `12.50 SOL` |

### Message Structure

Every message follows this pattern:
```
[Header — emoji + bold title]

[Key metric — largest, most important number]

[Details — secondary info, aligned]

[Footer note — if needed, small italic caveat]
```

### Button Conventions

- Destructive / irreversible actions: prefixed with ❌ or ⚠️
- Confirmation: `✅ Confirm`
- Cancel always available: `← Back` or `✕ Cancel`
- Navigation: `← Back` (left arrow)
- Disabled/unavailable: shown as `—` in button text or omitted

### Emoji Legend (consistent use across all messages)

| Emoji | Meaning |
|---|---|
| 🟢 | Long position / positive value |
| 🔴 | Short position / negative value |
| 📊 | Market / chart data |
| 💰 | Balance / money |
| 📥 | Deposit |
| 📤 | Withdraw |
| ⚙️ | Settings |
| ⚠️ | Warning |
| ✅ | Success / confirm |
| ❌ | Error / cancel |
| 🔔 | Alert |
| 📋 | List / history |
| 🔒 | Locked / security |

---

## Navigation Map

```
/balance ──────────────────────────────┐
  [Deposit] → Flow: Deposit             │
  [Withdraw] → Flow: Withdraw           │
  [Open positions] → Flow: Positions    │
                                        │
/markets                                │
  [symbol row] → Flow: Market Info ─────┼──→ Flow: Open Trade
                                        │
/price <symbol> → Flow: Market Info ────┼──→ Flow: Open Trade
                                        │
/long <symbol>  ─────────────────────── ┼──→ Flow: Open Trade
/short <symbol> ─────────────────────── ┘

Flow: Open Trade (success)
  [View positions] → Flow: Positions
  [Set stop loss]  → Flow: Set Stop Loss
  [Set take profit]→ Flow: Set Take Profit

Flow: Positions
  [Close X%]    → Flow: Close Position
  [Add margin]  → Flow: Add Margin
  [Edit SL]     → Flow: Set Stop Loss
  [Edit TP]     → Flow: Set Take Profit

/history → Flow: Trade History
/settings → Flow: Settings
/alerts  → Flow: Alerts
```

---

## Flow 1 — Account Overview

**Trigger:** `/balance`

### Step 1.1 — Main screen

```
💰 Your Account

Total value       $738.80
Available margin  $523.40
In positions      $200.00

Unrealized P&L   +$17.50
Pending funding   -$2.10

Wallet: AbC...XyZ
```

Buttons:
```
[📥 Deposit]  [📤 Withdraw]
[📊 Positions]  [📋 History]
```

> **Available margin** = deposited collateral − margin locked in positions (discounted by unrealized PnL risk factor). This is what you can actually open new trades with.

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| No Phoenix account yet | Show onboarding prompt: _"You haven't set up your account yet. Type /start to get started."_ |
| Phoenix API timeout | _"Couldn't load your account right now. Try again in a moment."_ + `[Try again]` button |
| Zero balance, no positions | Show balance as $0.00 with `[📥 Deposit to start trading]` CTA |
| Negative effective collateral | Show ⚠️ banner: _"Your margin is below zero — positions may be liquidated soon."_ |

---

## Flow 2 — Deposit

**Trigger:** `/deposit` or `[📥 Deposit]` from account overview

### Step 2.1 — Deposit screen

```
📥 Add Funds

Send USDC to your wallet address:

AbCdEfGhIjKlMnOpQrStUvWxYz1234567890

[QR code image]

Your USDC arrives automatically — 
no extra steps needed.

Also send a tiny amount of SOL (≈0.01 SOL) 
to cover transaction fees.
```

Buttons:
```
[📋 Copy address]
[← Back]
```

> Note: Only send **USDC** to this address. Other tokens will be lost. USDC is automatically wrapped for trading.

---

### Edge Cases / Validation

| Situation | Behaviour |
|---|---|
| QR generation fails | Show address as text only, no image; note: _"QR code unavailable — copy the address above."_ |
| User sends wrong token | Bot cannot detect this; shown as a static warning in the message |
| User asks about minimum deposit | No enforced minimum; mention in message: _"Minimum recommended: $10 to cover fees."_ |

---

## Flow 3 — Withdraw

**Trigger:** `/withdraw <amount>` or `[📤 Withdraw]` from account overview

### Step 3.1 — Amount entry (when no amount typed)

If user types just `/withdraw`:
```
📤 Withdraw Funds

How much USDC do you want to withdraw?

Available: $523.40

Reply with the amount, e.g.: 100
```

No buttons — user replies with a number.

---

### Step 3.2 — Confirmation (first step)

```
📤 Withdraw $250.00

From your trading account to:
AbC...XyZ

⚠️ For security, you'll need to confirm 
again in 5 minutes.

Tap confirm to start the 5-minute timer.
```

Buttons:
```
[✅ Start withdrawal]  [✕ Cancel]
```

---

### Step 3.3 — Waiting screen (after first confirm)

```
🔒 Withdrawal pending

$250.00 USDC

Confirm again after 5 minutes to complete.
You'll get a reminder.
```

Buttons:
```
[✕ Cancel withdrawal]
```

---

### Step 3.4 — Second confirmation (after 5 minutes)

```
🔒 Final confirmation

Withdraw $250.00 USDC to:
AbC...XyZ

This is irreversible.
```

Buttons:
```
[✅ Confirm withdrawal]  [✕ Cancel]
```

---

### Step 3.5 — Processing

```
⏳ Withdrawal submitted

$250.00 USDC

Large withdrawals may take a few minutes 
to process due to on-chain queue limits.
You'll get a message when it's done.
```

---

### Step 3.6 — Success

```
✅ Withdrawal complete

$250.00 USDC sent to your wallet.
```

---

### Edge Cases / Validation

| Situation | Message |
|---|---|
| Amount = 0 or negative | _"Enter an amount greater than $0."_ |
| Amount > available margin | _"You only have $523.40 available. Enter a smaller amount."_ |
| Non-numeric input | _"That doesn't look like a valid amount. Try: 250"_ |
| Open positions covering full margin | ⚠️ _"You have $200.00 locked in positions. Withdrawing too much could liquidate your trades."_ Show current available and ask to confirm |
| Withdrawal queue full (protocol limit) | _"The withdrawal queue is currently at capacity. Your withdrawal is queued and will process automatically — usually within a few minutes."_ |
| 5-min confirmation window expired | _"Your withdrawal request expired. Start over with /withdraw."_ |
| User cancels mid-flow | _"Withdrawal cancelled."_ — remove pending state |
| Amount below $1 | _"Minimum withdrawal is $1.00."_ |

---

## Flow 4 — Browse Markets

**Trigger:** `/markets`

### Step 4.1 — Market list (page 1)

```
📊 Markets  (page 1 / 4)

BTC/USD   $49,850   +2.4%  18% funding
ETH/USD    $2,634   -0.8%   9% funding
SOL/USD     $182.4  +5.1%  42% funding
BNB/USD     $412.0  -1.2%   6% funding
AVAX/USD     $38.2  +0.3%  12% funding
DOGE/USD    $0.184  +8.2%  71% funding
MATIC/USD    $0.92  -2.1%   4% funding
ARB/USD      $1.24  +1.4%  11% funding
GOLD/USD   $2,312   +0.1%   2% funding  [ISO]
SILVER/USD  $28.40  +0.2%   1% funding  [ISO]
```

Buttons:
```
[→ Next page]
```

> `[ISO]` = Isolated margin only — advanced feature

---

### Step 4.2 — Tapping a market row

Tapping any market row opens **Flow 5: Market Info** for that symbol.

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| API fails to load markets | _"Couldn't load markets right now. Try again."_ + `[Try again]` |
| No markets available | _"No markets available at the moment."_ |
| User on last page | Hide `[→ Next page]`; show `[← Prev page]` only |

---

## Flow 5 — Market Info

**Trigger:** `/price <symbol>`, `[📊 BTC]` button from anywhere, or tapping a row in `/markets`

### Step 5.1 — Market info screen

```
📊 BTC/USD

Price       $49,850.00
24h change  +$1,152  (+2.36%)

Funding     +18.24% / yr
            Longs pay shorts
Open interest  $4.2M

Max leverage   20x
Taker fee      0.10%
```

Buttons:
```
[🟢 Buy / Long]  [🔴 Sell / Short]
[🔔 Price alert]  [← Back]
```

> **Funding:** Paid every 8 hours between longs and shorts. Positive = longs pay shorts. Negative = shorts pay longs.

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| Symbol not found | _"Market 'XYZ' not found. Try /markets to see all available markets."_ |
| Isolated-only market (`[ISO]`) | Add note: _"⚠️ This market requires isolated margin (advanced). Standard long/short not available yet."_ — disable `[Buy/Long]` and `[Sell/Short]` buttons |
| Funding rate extreme (> ±100% APR) | Highlight in yellow with ⚠️: _"⚠️ Extreme funding rate — holding this position overnight is expensive."_ |
| API timeout | _"Couldn't load BTC/USD data. Try again."_ + `[Try again]` |

---

## Flow 6 — Open a Trade (Long / Short)

**Trigger:** `/long [symbol]`, `/short [symbol]`, `[🟢 Buy / Long]` or `[🔴 Sell / Short]` from market info

This flow handles both long and short. All UI is identical except labels.

---

### Step 6.1 — Symbol selection (only if not provided)

If user types just `/long` or `/short` with no symbol:

```
Which market do you want to trade?

Popular markets:
[BTC] [ETH] [SOL] [BNB]

[Browse all markets]
```

---

### Step 6.2 — Leverage selection

```
🟢 BTC/USD — Buy / Long

Price now:  $49,850.00
Funding:    +18.24% / yr  (you'll pay this)

How much leverage?

Higher leverage = bigger gains, faster liquidation.
```

Buttons:
```
[2x]  [3x]  [5x]  [10x]  [20x]
[Custom]  [✕ Cancel]
```

> Max leverage shown is market max. Buttons cap at market max automatically.
> If user's `defaultLeverage` setting is set, highlight that button (e.g., `[5x ★]`).

**Custom leverage input:**
```
Enter your leverage (1–20):
```
User replies with a number. Validate on receipt.

---

### Step 6.3 — Size selection

(After leverage chosen — say user picked 10x)

```
🟢 BTC/USD — Long 10x

Your available margin:  $523.40
Position will be:       10× your margin

How much margin do you want to use?
```

Buttons:
```
[$52  (10%)]  [$130  (25%)]
[$261  (50%)] [$523  (100%)]
[Custom amount]  [✕ Cancel]
```

> **Margin** is what you risk. Your actual position is 10× that.

**Custom amount input:**
```
Enter the margin amount in USD:
(Available: $523.40)
```
User replies with a number.

---

### Step 6.4 — Trade confirmation

```
📋 Review your trade

🟢 BTC/USD — Long 10x

Position size    $5,234.00
Your margin      $523.40
Entry price      ~$49,850.00
Fee (0.10%)      $5.23

Liquidated if price drops to:  $44,865.00
                               (-10%)

⚠️ Funding costs: +18.24% / yr
   You pay ≈$0.26 / day on this position.
```

Buttons:
```
[✅ Open trade]  [✕ Cancel]
```

> Funding cost per day shown only if APR > 10%.

---

### Step 6.5 — Submitting

```
⏳ Opening your trade…
```

(Shown while on-chain transaction processes)

---

### Step 6.6 — Success

```
✅ Trade opened!

🟢 BTC/USD — Long 10x
Position: $5,234.00
Filled at: $49,872.14
Fee paid:  $5.23
```

Buttons:
```
[📊 View positions]
[🛑 Set stop loss]  [🎯 Set take profit]
```

---

### Step 6.7 — Failure

```
❌ Trade failed

Couldn't open your BTC/USD long.
Reason: [human-readable reason]

[Try again]  [← Back]
```

---

### Validation Rules

| Input | Rule | Error message |
|---|---|---|
| Symbol | Must exist in market list | _"Market '[X]' not found."_ |
| Symbol | Must not be isolated-only | _"[X] requires isolated margin — not available yet."_ |
| Leverage | Must be ≥ 1 and ≤ market max | _"Leverage must be between 1x and [max]x for this market."_ |
| Leverage | Non-numeric input | _"Enter a number, e.g. 10"_ |
| Size (margin) | Must be > 0 | _"Enter an amount greater than $0."_ |
| Size (margin) | Must be ≤ available margin | _"You only have $523.40 available. Enter a smaller amount."_ |
| Size (margin) | Must meet minimum notional | _"Minimum trade size is $10."_ |
| Size (margin) | Non-numeric input | _"Enter a number, e.g. 100"_ |

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| No account / not onboarded | _"You need to set up your account first. Type /start."_ |
| Zero available margin | _"Your available margin is $0. Deposit funds first."_ + `[📥 Deposit]` |
| Available margin < minimum trade | _"You need at least $10 available to open a trade. You have $X."_ |
| User already has position in same market (same side) | ⚠️ _"You already have a long open on BTC/USD. Opening another will increase your position size."_ — allow to proceed |
| User already has position in same market (opposite side) | ⚠️ _"You have a short open on BTC/USD. Opening a long will reduce or flip your position."_ — allow to proceed |
| Rate limit hit (5 orders/min) | _"Slow down — you've placed 5 orders in the last minute. Try again shortly."_ |
| Price moved > 1% since confirmation screen loaded | Show updated price and ask to re-confirm: _"Price has moved to $49,200. Still want to open?"_ |
| On-chain transaction fails | Show specific error. Common ones: _"Insufficient SOL for fees — top up with ≈0.01 SOL."_ / _"Order rejected by exchange."_ |
| User hits Cancel at any step | _"Trade cancelled."_ — clear all pending state, no further action |

---

## Flow 7 — Open Positions

**Trigger:** `/positions` or `[📊 Positions]` from account overview

### Step 7.1 — No open positions

```
📊 Open Positions

You have no open positions.

Ready to trade?
```

Buttons:
```
[Browse markets]  [📋 History]
```

---

### Step 7.2 — Position list (one card per position)

Each position gets its own message card:

```
🟢 BTC/USD — Long 10x

Size          0.1050 BTC  ($5,234.00)
Entry price   $49,850.00
Mark price    $50,017.00

Profit        +$17.64  (+0.34%)
Funding       -$2.10

Liquidation   $44,865.00

Stop loss     $47,000.00  ✓
Take profit   None
```

Buttons:
```
[Close 25%]  [Close 50%]
[Close 75%]  [Close all]
[Add margin]  [Edit SL]  [Edit TP]
```

If multiple positions, each has its own card sent sequentially.

After all cards, a summary message:

```
📊 Summary

Total margin in positions:   $523.40
Total unrealized P&L:        +$17.64
Pending funding:             -$2.10
```

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| API fails | _"Couldn't load your positions. Try again."_ + `[Try again]` |
| Position liquidated since last check | Card shows: _"⚠️ This position was liquidated."_ — no action buttons |

---

## Flow 8 — Close a Position

**Trigger:** `[Close 25%]`, `[Close 50%]`, `[Close 75%]`, `[Close all]` from positions screen

### Step 8.1 — Confirmation

```
Close 50% of BTC/USD Long?

Closing:    0.0525 BTC  ($2,617.00)
At price:   ~$50,017.00
Est. fee:   $2.62  (0.10%)

Profit on this portion:  +$8.82  (+0.34%)
```

Buttons:
```
[✅ Close position]  [✕ Cancel]
```

---

### Step 8.2 — Processing

```
⏳ Closing position…
```

---

### Step 8.3 — Success

```
✅ Position closed

BTC/USD Long  (50%)
Closed at:   $50,031.00
Realized P&L:  +$9.10
Fee:           -$2.62
```

Buttons:
```
[📊 View positions]  [📋 History]
```

---

### Step 8.4 — Failure

```
❌ Couldn't close position

BTC/USD Long
Reason: [reason]

[Try again]  [← Back]
```

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| Position closed or flipped before confirmation | _"Your position has changed. Reload positions to see the current state."_ + `[📊 Positions]` |
| "Close all" but position is already closing | _"A close order is already pending for this position."_ |
| Fractional close results in position below minimum notional | Auto-upgrade to full close: _"Closing this fraction would leave a position below the minimum size — closing 100% instead."_ |

---

## Flow 9 — Add Margin

**Trigger:** `[Add margin]` from positions screen

### Step 9.1 — Prompt

```
Add Margin — BTC/USD Long

Current margin:    $523.40
Available to add:  $0.00

⚠️ You have no free margin available.
Deposit more funds first.
```

(If available margin = 0, show deposit CTA instead)

If margin is available:
```
Add Margin — BTC/USD Long

Current margin:    $300.00
Available to add:  $223.40

Current liq. price:  $44,865.00

How much to add? Reply with the amount.
```

---

### Step 9.2 — Confirmation

(After user replies with amount, e.g. `100`)

```
Add $100.00 margin to BTC/USD Long?

New margin:        $400.00
New liq. price:    $41,518.00  (safer)
```

Buttons:
```
[✅ Add margin]  [✕ Cancel]
```

---

### Step 9.3 — Success

```
✅ Margin added

+$100.00 to BTC/USD Long
New liquidation price:  $41,518.00
```

---

### Validation Rules

| Input | Rule | Error message |
|---|---|---|
| Amount | Must be > 0 | _"Enter an amount greater than $0."_ |
| Amount | Must be ≤ available margin | _"You only have $223.40 available."_ |
| Amount | Non-numeric | _"Enter a number, e.g. 100"_ |

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| Position closed before margin added | _"This position is no longer open."_ |
| Position is cross-margin | Adding margin increases collateral across all positions — note: _"Adding margin improves collateral across all your cross-margin positions."_ |

---

## Flow 10 — Set / Edit Stop Loss

**Trigger:** `[Edit SL]` from positions, `/setsl <symbol> <price>`, or `[🛑 Set stop loss]` after opening a trade

### Step 10.1 — Current state display + prompt

If no stop loss set:
```
🛑 Set Stop Loss — BTC/USD Long

Current price:     $50,017.00
Entry price:       $49,850.00
Liquidation at:    $44,865.00

No stop loss set.

What price should we close your position?
Reply with a price, e.g.: 48000

Your stop loss must be below the current price
for a long position.
```

If stop loss already set:
```
🛑 Edit Stop Loss — BTC/USD Long

Current price:     $50,017.00
Current stop loss: $47,000.00

What's your new stop loss price?
Reply with a price, or send 0 to remove it.
```

---

### Step 10.2 — Mode selection (after user replies with price, e.g. `48000`)

```
Stop loss at $48,000.00

How should we close when price hits $48,000?

Market — Close immediately at best available price
         (may fill slightly below $48,000)

Limit  — Place a sell order at exactly $48,000
         (may not fill if price moves past quickly)
```

Buttons:
```
[Market (recommended)]  [Limit]
[✕ Cancel]
```

---

### Step 10.3 — Confirmation

```
Set stop loss?

BTC/USD Long
Stop at:   $48,000.00 (Market)
Max loss:  -$190.00  (-3.7% from entry)
           -$190.00  (-3.7% from now)
```

Buttons:
```
[✅ Set stop loss]  [✕ Cancel]
```

---

### Step 10.4 — Success

```
✅ Stop loss set

BTC/USD Long
Stop at:  $48,000.00

You'll be notified when it triggers.
```

---

### Step 10.5 — Remove stop loss (if user sent `0`)

```
Remove stop loss?

BTC/USD Long
Current stop loss: $47,000.00
```

Buttons:
```
[✅ Remove stop loss]  [✕ Cancel]
```

---

### Validation Rules

| Input | Rule | Error message |
|---|---|---|
| Price (long) | Must be < current mark price | _"Stop loss must be below the current price ($50,017). For a long, you're protected against price drops."_ |
| Price (short) | Must be > current mark price | _"Stop loss must be above the current price ($50,017). For a short, you're protected against price rises."_ |
| Price (long) | Must be > liquidation price | _"That price is below your liquidation price ($44,865). Set it higher."_ |
| Price | Must be > 0 (unless explicitly removing) | _"Enter a price greater than $0, or send 0 to remove your stop loss."_ |
| Price | Non-numeric | _"Enter a price, e.g. 48000"_ |

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| No open position for that symbol | _"You don't have an open BTC/USD position."_ |
| Position flipped (was long, now short) | _"Your BTC/USD position has changed direction. Check /positions."_ |
| Stop loss already pending/triggered | _"Your previous stop loss is already active. Setting a new one will replace it."_ — allow to proceed |
| Price very close to mark price (<0.5% away) | ⚠️ _"That stop loss is very close to the current price ($50,017) and could trigger immediately."_ — ask to confirm |

---

## Flow 11 — Set / Edit Take Profit

**Trigger:** `[Edit TP]` from positions, `/settp <symbol> <price>`, or `[🎯 Set take profit]` after opening a trade

### Step 11.1 — Current state display + prompt

If no take profit set:
```
🎯 Set Take Profit — BTC/USD Long

Current price:  $50,017.00
Entry price:    $49,850.00
Profit so far:  +$17.64  (+0.34%)

No take profit set.

What price should we lock in your profit?
Reply with a price, e.g.: 55000

Your take profit must be above the current price
for a long position.
```

If take profit already set:
```
🎯 Edit Take Profit — BTC/USD Long

Current price:       $50,017.00
Current take profit: $55,000.00

What's your new take profit price?
Reply with a price, or send 0 to remove it.
```

---

### Step 11.2 — Mode selection

```
Take profit at $55,000.00

How should we close when price hits $55,000?

Market — Close immediately at best available price

Limit  — Place a sell order at exactly $55,000
         (may not fill if price spikes past quickly)
```

Buttons:
```
[Market]  [Limit (recommended)]
[✕ Cancel]
```

---

### Step 11.3 — Confirmation

```
Set take profit?

BTC/USD Long
Take profit at:  $55,000.00 (Limit)
Expected gain:   +$525.00  (+10.3% from entry)
                 +$507.36  (+9.9% from now)
```

Buttons:
```
[✅ Set take profit]  [✕ Cancel]
```

---

### Step 11.4 — Success

```
✅ Take profit set

BTC/USD Long
Take profit at:  $55,000.00

You'll be notified when it triggers.
```

---

### Validation Rules

| Input | Rule | Error message |
|---|---|---|
| Price (long) | Must be > current mark price | _"Take profit must be above the current price ($50,017) for a long."_ |
| Price (short) | Must be < current mark price | _"Take profit must be below the current price ($50,017) for a short."_ |
| Price | Non-numeric | _"Enter a price, e.g. 55000"_ |

---

### Edge Cases (same structure as Stop Loss)

| Situation | Behaviour |
|---|---|
| No open position | _"You don't have an open BTC/USD position."_ |
| Take profit below/above liquidation range | Very unlikely but flag with ⚠️ |
| Price spike — TP already triggered | _"Your take profit may have already triggered. Check /positions."_ |

---

## Flow 12 — Trade History

**Trigger:** `/history` or `[📋 History]` from account overview

### Step 12.1 — Trade history list

```
📋 Trade History

BTC/USD  Long    $50,031  +$9.10  May 21, 14:32
ETH/USD  Short   $2,601   -$4.20  May 21, 11:07
SOL/USD  Long     $180.2  +$22.40  May 20, 18:55
BTC/USD  Long    $49,200  -$12.50  May 20, 09:14
ETH/USD  Long    $2,580   +$31.00  May 19, 22:40

… and 15 more trades
```

Buttons:
```
[📤 Export CSV]  [← Back]
```

> Showing the 20 most recent closed trades. Green = profit, red = loss.

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| No trade history | _"No closed trades yet. Open your first trade with /markets."_ |
| API fails | _"Couldn't load trade history. Try again."_ |
| Only 1 trade | Show single row, no "and X more" line |

---

## Flow 13 — Settings

**Trigger:** `/settings`

### Step 13.1 — Settings panel

```
⚙️ Settings

Default leverage:    5x  ●
Slippage tolerance:  0.5%  ●

These apply to new trades only.
Open positions are not affected.
```

Buttons (leverage row — current value highlighted):
```
[2x]  [3x]  [★5x]  [10x]  [25x]
```

Buttons (slippage row):
```
[0.1%]  [★0.5%]  [1.0%]  [2.0%]
```

> ★ = current selection

---

### Step 13.2 — Confirmation after change

Settings apply immediately, no extra confirmation needed. After tap:

```
⚙️ Settings updated

Default leverage:    10x  ●
Slippage tolerance:  0.5%  ●
```

(Panel refreshes with new selection highlighted)

---

### Edge Cases

| Situation | Behaviour |
|---|---|
| User taps already-selected option | Show: _"Already set to [X]."_ — no DB write |
| DB write fails | _"Couldn't save your settings. Try again."_ |

---

## Flow 14 — Price Alert

**Trigger:** `[🔔 Price alert]` from market info screen, or `/alert <symbol> <price>`

### Step 14.1 — Alert setup

If arriving from market info (price already visible):
```
🔔 Price Alert — BTC/USD

Current price:  $49,850.00

What price should we alert you at?
Reply with a price, e.g.: 52000

Use a + prefix for "above" (e.g. 52000)
or – prefix for "below" (e.g. -48000).
Above works if positive, below if negative.
```

Simpler language alternative:
```
Reply with a price.
We'll alert you when BTC/USD crosses it.
To alert when price falls below, add a minus: -48000
```

---

### Step 14.2 — Confirmation

```
Set price alert?

BTC/USD
Alert when price reaches:  $52,000.00  ↑
Current price:             $49,850.00
```

Buttons:
```
[✅ Set alert]  [✕ Cancel]
```

---

### Step 14.3 — Success

```
🔔 Alert set

BTC/USD  →  $52,000.00

We'll message you when the price crosses this level.
```

---

### Validation Rules

| Input | Rule | Error message |
|---|---|---|
| Price = current price | Block | _"That's the current price. Set a target that's above or below."_ |
| Price | Non-numeric | _"Enter a price, e.g. 52000"_ |
| Duplicate alert (same symbol + price) | _"You already have an alert set for BTC/USD at $52,000."_ |
| Too many alerts per symbol | Limit 3 per symbol: _"You already have 3 price alerts for BTC/USD. Remove one first."_ |

---

## Error States Reference

These messages apply globally across all flows.

| Error | Message |
|---|---|
| User not onboarded | _"You haven't set up your account yet. Type /start to get started."_ |
| Rate limit (general, 20/min) | _"Too many requests — slow down and try again in a moment."_ |
| Rate limit (orders, 5/min) | _"You've placed 5 orders in the last minute. Try again shortly."_ |
| Not enough SOL for fees | _"Your wallet needs more SOL to pay transaction fees. Send ≈0.01 SOL to your wallet."_ |
| Phoenix API unavailable | _"The exchange is temporarily unavailable. Try again in a moment."_ |
| Unknown on-chain error | _"Something went wrong on-chain. Your funds are safe — check /positions and try again."_ |
| Session expired / pending state lost | _"Your previous action expired. Start again."_ |

---

## Validation Rules — Master Reference

### Numbers

- All price inputs: strip `$` and `,` before parsing
- All amount inputs: strip `$` and `,` before parsing
- Reject: letters, multiple dots, empty strings
- Accept: decimal points (e.g. `49850.50`)
- Trim whitespace from all inputs

### Symbols

- Normalize to uppercase (e.g. `btc` → `BTC`)
- Strip `/USD` or `/USDT` suffix if provided (e.g. `BTC/USD` → `BTC`)
- Fuzzy match common typos (e.g. `DOGE1` → suggest `DOGE`)

### Leverage

- Parse as integer or float (e.g. `10`, `10x`, `10X` all valid)
- Strip `x` suffix
- Round to nearest integer if decimal (e.g. `9.7x` → `10x`)
- Min: 1, Max: market-specific

### Amounts (USD)

- Parse as float
- Round to 2 decimal places
- Min: $1.00 for deposits/withdrawals, $10.00 for trades
- Max: user's available margin (checked server-side)

---

## Pending State Reference

Redis key: `pending:{telegramId}` — stores action context for multi-step text-reply flows.

| Value | Flow | Expected reply |
|---|---|---|
| `addmargin:{symbol}` | Add Margin | USD amount |
| `editsl:{symbol}:{side}` | Set Stop Loss | USD price (or 0 to remove) |
| `edittp:{symbol}:{side}` | Set Take Profit | USD price (or 0 to remove) |
| `withdraw:amount` | Withdraw — amount step | USD amount |
| `leverage:{symbol}` | Open Trade — custom leverage | Integer |
| `size:{symbol}:{leverage}` | Open Trade — custom size | USD amount |

All pending keys should have a **10-minute TTL**. On expiry, if user sends a reply, respond: _"Your previous action expired. Start again."_

---

## Callback Data Formats

All inline button callbacks encoded as colon-separated strings:

| Action | Format | Example |
|---|---|---|
| Close position | `close:{symbol}:{percent}` | `close:BTC:50` |
| Confirm trade | `confirm:{side}:{symbol}:{leverage}:{size}:{markprice}` | `confirm:long:BTC:10:523.40:49850.00` |
| Set SL mode | `sl:mode:{symbol}:{price}:{mode}` | `sl:mode:BTC:48000:market` |
| Set TP mode | `tp:mode:{symbol}:{price}:{mode}` | `tp:mode:BTC:55000:limit` |
| Market page | `markets:page:{n}` | `markets:page:2` |
| Alert toggle | `alert:toggle:{type}` | `alert:toggle:fill` |
| Slippage | `slip:{bps}` | `slip:50` |
| Leverage default | `lev:{n}` | `lev:10` |

**Note:** `markprice` in trade callbacks should accept decimal values (`[\d.]+`), not just integers.
