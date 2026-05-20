# Self-Trade Prevention

## Overview
Phoenix has explicit self-trade prevention modes at the matching-engine layer.

## Available behaviors

| Behavior | What happens |
| --- | --- |
| `Abort` | Reject the self-cross instead of matching it |
| `CancelProvide` | Cancel the resting provide-side order on the self-cross |
| `DecrementTake` | Reduce the incoming take-side quantity by the self-cross amount |

## Default behavior
For the core limit and IOC builders, the protocol defaults to `CancelProvide` unless the caller explicitly chooses another behavior. Some specialized flows use stricter defaults. For example:
- many SDK examples use `Abort`
- TP/SL-triggered orders are designed to avoid accidental self-matching

## Why this matters
Without STP, a trader could:
- fill against their own resting order
- pay fees for a meaningless self-match
- distort fill history and realized PnL

## User-facing outcomes
If a self-cross is detected, you may see:
- an order reject
- a resting order cancellation
- an incoming order that fills less than its original requested size

Those are not random outcomes. They depend on the selected STP mode.
