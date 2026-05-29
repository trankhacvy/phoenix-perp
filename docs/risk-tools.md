# SuperNova — Alerts, Trader Monitor & Guardian

A trader's guide to the tools that watch the market and your positions for you:

1. **Price Alerts** — ping me when a market hits a price.
2. **Trader Monitor** — ping me when another wallet trades.
3. **Guardian** — watch *my* positions 24/7 and warn me (or act) when risk rises.

---

## First, the most important thing: two kinds of protection

The app gives you **two** safety layers. They work differently — know which is which.

| | **On-chain orders** (TP/SL "🛡 Protect" brackets) | **Guardian / Price Alerts** |
|---|---|---|
| Lives on | Phoenix exchange (on-chain) | Our bot |
| Works if the bot is offline? | ✅ Yes | ❌ No |
| Reliability | Hard — executes at the exchange | Best-effort — depends on live data + bot uptime |
| Good for | A firm stop-loss / take-profit price | Smarter rules a fixed price can't express (trailing stop, drawdown-from-peak, funding cost, total exposure, auto-add margin) |

**Rule of thumb:** for a hard "get me out at this price," use an **on-chain order**. Use **Guardian** for smarter, conditional, or portfolio-wide reactions on top of that. They're complementary — most serious traders use both.

> **A word on prices:** everywhere in this doc, **"price" means mark price** — the official Phoenix price used for your PnL and liquidation, and the one shown on the market screen. We never use the order-book midpoint for alerts or rules, so what triggers always matches what you see.

---

## 1. Price Alerts

**What it does:** notifies you once when a market reaches a price you choose.

**Set it up:** open a market → **🔔 Set price alert** → type a price (e.g. `BTC 70000`).
- We auto-detect direction: target **above** the current price → an "above" alert; **below** → a "below" alert. No need to pick.

**Concrete example:** BTC is at **$65,000**. You set an alert at **$70,000**. The moment mark price touches $70,000, you get: *"🔔 BTC reached $70,000 (your target, above)."* It then auto-disables so it doesn't repeat.

**When it fires:**
- The instant **mark price** crosses your target. Fires **once**, then **auto-disables**.
- The alert has a **🔁 Re-enable** button and quick **Long / Short / View market** buttons.

**Good to know / limits:**
- It's an **alert, not an order** — it tells you, it doesn't trade for you.
- Best-effort: it relies on the bot being online. For a guaranteed action at a price, use an on-chain order.

---

## 2. Trader Monitor

**What it does:** watches another trader's wallet and pings you when they act — follow smart money, copy, or fade them.

**Set it up:** `/monitor <wallet address>` (or the **👁 Monitor** button on a trader's profile). Add a label so you remember who's who.

**What you get pinged on — each toggle works independently:**
- **Position changes** — when they **open**, **close**, or **flip** (long↔short). Shows side, size, entry.
- **Fills** — each time one of their orders executes (buy/sell, size, price).
- **Liquidations** — when a wallet you follow gets **liquidated**. (Great signal — when a big trader blows up, the market often moves.)

**Concrete example:** you monitor a whale with fills **off** and position-changes **on**. They scale into a position with five fills — you stay quiet. Then they **flip SOL from long to short** — you get one ping: *"👁 Whale flipped SOL: LONG → SHORT,"* with **Copy Short / Counter Long** buttons.

Every alert carries **Copy / Counter** buttons (open the same or opposite trade in one tap) and a **📊 Trader** button.

**Good to know / limits:**
- The on/off toggles **actually gate what you receive** — turn fills off and you only get position changes.
- We only see activity **while the bot is running**; trades during downtime aren't replayed.
- This is **monitoring, not auto-copy** — nothing trades automatically.

---

## 3. Guardian — your 24/7 risk watchdog

**What it does:** you define risk rules; Guardian watches your positions around the clock and, when a rule trips, it **alerts you**, **offers one-tap actions**, or **acts automatically** — your choice per rule.

**Set it up:** `/guardian` → **+ New rule** (or **📋 Quick presets**: Conservative / Moderate / Aggressive). Pick: *what to watch → which market → threshold → what to do.*

### The rules (plain English, with examples)

#### ⚡ Liquidation Distance
Fires when your **liquidation price** gets within **X%** of the current price.
> *Example:* BTC long, mark **$60,000**, your liquidation at **$54,000** — that's **10%** away. A "within 10%" rule trips right here.

#### 🛟 Trailing Stop *(new — backed by an on-chain order)*
A stop that **follows the price up and never moves down**, locking in gains. You set a **trail %**; as price makes new highs, Guardian moves your on-chain stop-loss up behind it.
> *Example:* SOL long, **5% trail**. Price runs $100 → $120, so your stop ratchets up to **$114** (5% below the $120 high). Price keeps climbing to $130 → stop moves up to **$123.50**. It never moves down. If price then pulls back 5% from the high, the **on-chain stop** closes you.
>
> Why it's special: the trail logic is Guardian's, but the actual exit is a **real on-chain order**, so it still fires even if the bot is briefly offline. Fixed TP/SL brackets can't move themselves up — this can.

#### 🎯 Move to Breakeven *(new — backed by an on-chain order)*
A one-time action: once profit reaches **+X%**, Guardian sets your on-chain stop-loss to your **entry price** (plus a tiny buffer for fees), so the trade can no longer turn into a loss.
> *Example:* ETH long entered at **$3,000**, rule **+30%**. When profit hits +30% of your margin, Guardian places an on-chain SL at ~$3,000. From then on, worst case is roughly breakeven.

#### 📉 Drawdown
Fires when your **profit falls X% from its highest point** — measured as a share of your *peak profit*, not a price move. Only applies once you're in profit.
> *Example:* SOL long, entry **$100**, size 100 SOL. Price hits **$120** → peak profit **+$2,000**. A **20%** drawdown rule trips when profit falls to **$1,600** (you've handed back $400 of the $2,000 peak) — that's at price **$116**.
>
> *Trailing Stop vs Drawdown:* both ratchet off a peak, but Trailing Stop measures a **price** pullback (and exits via an on-chain order), while Drawdown measures **profit given back** (a bot-side reaction). Most traders want the Trailing Stop; Drawdown is handy for flexible, PnL-based exits.

#### 🎯 PnL Target
Fires when a position's profit/loss hits **+X%** or **−X%** of the **margin you put in**.
> *Example:* you opened ETH with **$200** margin. A **+50%** rule pings at **+$100** profit; a **−25%** rule pings at **−$50**.

#### 💸 Funding Cost
Fires when the funding you **pay** on a position exceeds **$X/day**. Only counts funding you *pay* — if a position is *earning* funding, it never trips.
> *Example:* holding a $50,000 long while funding is steeply positive could cost ~$30/day. A "more than $25/day" rule pings so you can decide if the carry is worth it.

#### 📊 Total Exposure
Fires when your **combined position size across all markets** exceeds **$X**.
> *Example:* a "$50K" rule pings the moment your open positions add up past $50,000 notional.

#### 🛟 Margin Health
Fires when your **account collateral vs total exposure** drops below **X%**.
> *Example:* a "15%" rule warns when your collateral is worth less than 15% of what you have open — you're getting thin across the whole account.

### What Guardian can do when a rule trips

You choose the action per rule:

- **🔔 Notify** — just message you.
- **🔔 Suggest** — message you **with one-tap buttons**: Close, Reduce 50%, Add $100 margin, Snooze.
- **⚡ Auto-close** — market-close 100% of the position, automatically.
- **⚡ Auto-reduce** — market-close part of it (e.g. 50%).
- **⚡ Auto-add margin** — move USDC from your bot wallet into the position to push liquidation away.
- **🛟 Set/Move on-chain stop** — used by **Trailing Stop** and **Move to Breakeven**: instead of closing you on the bot side, Guardian places or moves a **real on-chain stop**.

### Protect on open

When you open a trade, if it has **no stop-loss**, the app nudges you to add one (or, if you've set defaults, attaches an on-chain TP/SL automatically). Fewer naked positions, less reliance on Guardian reacting in the moment.

### Controls & safety

- **Cooldown:** after a rule fires, it waits before firing again, so you don't get a burst of the same alert.
- **Snooze:** mute a specific alert for the exact time on the button (e.g. "Snooze 30m" = 30 minutes).
- **Killswitch:** `/guardian off` (or **⏸ Disable all auto-actions**) instantly downgrades every auto-rule to "notify." Alerts keep coming; nothing executes on its own.
- **Presets:** start safe in two taps, fine-tune later.

### Honest limits — read before using auto-actions

- **Auto-actions use your bot wallet and run with no confirmation prompt.** That's the point — but enable them deliberately.
- **They can fail.** A network/exchange hiccup or low SOL for gas can stop an auto-close. Guardian then sends a **failure alert with a manual Close button** and retries — but a failure is possible at the worst moment (high volatility). Keep ~0.02 SOL in your bot wallet for gas.
- **Bot-side actions (auto-close/reduce/margin) are best-effort.** For protection that survives the bot being offline, prefer the **on-chain-backed** actions — **Trailing Stop**, **Move to Breakeven**, and plain **on-chain TP/SL**.
- **Drawdown needs a peak first.** A trade that's been red since you opened it never had a peak above zero, so it won't trip a Drawdown rule — use PnL Target or Liquidation Distance for that.

---

## Quick comparison

| | Price Alert | Trader Monitor | Guardian |
|---|---|---|---|
| Watches | a market price | another wallet | **your** positions |
| Acts for you? | No | No | Optionally (auto-actions / on-chain stops) |
| Fires on | price crossing | their trades & liquidations | your risk thresholds |
| Strongest mode | — | — | on-chain-backed (Trailing Stop, Breakeven) |
| Turn off | auto-disables after firing | per-wallet toggles | `/guardian off` killswitch |
