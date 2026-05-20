# FIFO Order Book

## Overview
Phoenix uses a FIFO order book for normal resting orders. FIFO means:
- better price fills first
- at the same price, older resting liquidity fills before newer resting liquidity

## What a resting order stores
A resting FIFO order stores:
- the maker trader position
- initial and remaining base size
- order flags
- optional conditional order index
- optional slot-based expiry
- initial slot

## Capacity and order limits
Phoenix enforces both per-trader open-order limits and market-level orderbook capacity.

- A trader can have up to `64` resting bid limit orders per market.
- A trader can have up to `64` resting ask limit orders per market.
- The per-trader limit is per market and per side, so one trader can have up to `128` resting FIFO orders on one market: `64` bids and `64` asks.
- IOC and other take-only orders do not count toward this cap because they do not rest on the book.

## Order packet families
At the protocol layer, the core order packet kinds are:

| Packet kind | User-facing mental model | Rests on book |
| --- | --- | --- |
| `PostOnly` | maker-only limit order | Yes |
| `Limit` | standard limit order | Yes, after any immediate matches |
| `ImmediateOrCancel` | IOC, market, or FOK depending on fields | No |

## Important fields

### `price_in_ticks`
The order price in native book ticks.

### `num_base_lots`
The total base size to fill or rest.

### `last_valid_slot`
Optional expiry slot for the order.

### `match_limit`
Optional cap on how many resting orders an incoming order can match against.

### `cancel_existing`
Advanced behavior that lets some order paths cancel conflicting resting orders instead of failing a margin check immediately.

## Maker vs taker behavior
- A resting order that provides liquidity is maker flow.
- An incoming aggressive order that removes resting liquidity is taker flow.
- A standard limit order can act as either, depending on whether it crosses the book.

## Post-only behavior
Post-only orders are for adding liquidity only.
- If they would immediately trade, they do not execute as takers.
- Depending on configuration, they may slide to a valid resting price rather than cross.

## Expiry and live L2 views
FIFO order expiry is slot-based. An expired order can remain in the raw book until a matching or maintenance path touches it. Consumers that need a live L2 view should filter expired FIFO orders before aggregating by price.
