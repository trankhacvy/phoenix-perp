# Order Types

## Overview
Phoenix exposes a small set of core order packet families and then layers user-facing controls on top.

## Core order families

| Public name | Protocol mental model | Rests on book | Notes |
| --- | --- | --- | --- |
| Market order | IOC with no explicit limit price | No | Pure taker flow |
| IOC | Immediate-or-cancel with an optional price cap | No | Cancels any unfilled remainder |
| FOK | IOC with minimum fill constraints | No | Entire minimum must fill or the order is voided |
| Limit order | Cross if possible, then rest | Yes | Can be maker or taker depending on price |
| Post-only order | Maker-only limit order | Yes | Will not take existing liquidity |

## User-facing modifiers

### Reduce only
Reduce-only orders can only decrease existing exposure.

### Post only
Post-only orders are used to add liquidity only. They do not execute immediately as takers.

### Take profit / stop loss
These are trigger orders evaluated against mark price. See Take Profit And Stop Loss.

### Expiration
Order packets can carry a `last_valid_slot`, which acts like an expiry.

### Match limit
Advanced callers can set `match_limit` to cap how many resting FIFO orders or spline price levels an incoming order may consume. This is separate from the open-order cap. `match_limit` controls taker-side matching work for one incoming order. The open-order cap controls how many resting limit orders a trader may already have on one market side. For FIFO matching, each maker order consumes one `match_limit` unit. For spline matching, one spline price level consumes one `match_limit` unit even if multiple splines participate at that level.

### Cancel existing
Some order flows can request cancellation of conflicting resting orders instead of failing a margin check immediately.

## How to think about order choice

### Use market / IOC when
- speed matters most
- you are willing to take available liquidity

### Use limit when
- you need a price bound
- you are okay with resting if not fully filled

### Use post-only when
- you explicitly want maker behavior
- you do not want an aggressive fill

## Self-trade behavior
Phoenix also lets the matching engine choose how to handle self-crosses. At the protocol layer, the supported behaviors are:
- `Abort`
- `CancelProvide`
- `DecrementTake`

Standard limit and IOC builders default to `CancelProvide` unless a caller overrides it.
