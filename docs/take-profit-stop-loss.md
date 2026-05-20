# Take Profit and Stop Loss

## Overview
Take Profit (TP) and Stop Loss (SL) are conditional, reduce-only orders that execute when the market's mark price crosses a trigger price you specify. You can attach TP/SL to an open position or to a resting limit order.

## When triggers fire
Triggers are evaluated against the market's mark price.

| Position | Take Profit fires when | Stop Loss fires when |
| --- | --- | --- |
| Long | Mark price ≥ TP price | Mark price ≤ SL price |
| Short | Mark price ≤ TP price | Mark price ≥ SL price |

## Execution style
When a trigger fires, the conditional order is placed on the book in one of two modes, which you select per leg:
- **Market:** Submitted as an immediate-or-cancel (IOC) order with a 10% slippage buffer around the trigger price.
- **Limit:** Submitted as a standard limit order at a price you specify. If your limit price doesn't cross the book, the order rests until it fills or is cancelled.

TP/SL orders are always reduce-only.

## Where to place TP/SL

### On a new order
From the order form, enable the TP/SL toggle to attach conditional legs to a market or limit order. You can set each leg by trigger price, by gain/loss percentage, or by dollar amount — the inputs stay in sync.

### On an open position
Open the positions table and click the TP/SL cell for the position you want to bracket. The edit modal lets you set or update both legs independently. When triggered, the order executes for your full position size at that moment.

### On a resting limit order
From the open orders table, open a limit order and attach TP/SL in the edit modal. Once attached, the TP and SL appear as child rows beneath the parent limit order and share the parent's size.

## Limit order TP/SL lifecycle
A TP/SL attached to a limit order is linked to its parent while the parent rests on the book.

- **Partial fill of the parent:** The attached TP/SL's fillable size updates to match the parent's filled amount. The trigger, if breached, executes up to the filled amount.
- **Full fill of the parent:** The TP/SL detaches from the parent and becomes an **orphaned** conditional order. Orphaned orders remain active and can execute up to their full size when triggered.
- **Parent cancelled:** All attached TP/SL children are cancelled with the parent.
- **Cancel all:** Cancels all open orders, including attached children and orphans.

You can edit or cancel a child TP/SL directly without touching the parent.

### Position flips
Closing a position and opening the opposite side invalidates all active TP/SL on that market, including both position-based orders and any orphans or attached children. You'll need to reattach TP/SL after flipping.

## Chart controls
TP/SL orders render as lines on the trading chart. You can edit or cancel them directly from the chart.

## Limitations
- TP/SL cannot be attached to reduce-only limit orders.
- Self-trade prevention applies on execution.
- A trader account supports a bounded number of active conditional orders per market.
