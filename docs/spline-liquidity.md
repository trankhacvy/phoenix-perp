# Spline Liquidity

## Overview
Spline liquidity is a Phoenix-specific liquidity source for quoting a shaped curve without placing one FIFO order at every price level. A spline trader publishes a mid price and bid/ask regions. The matching engine materializes those regions into visible price levels when it builds the combined book.

## Spline data model
Each spline has:
- a `mid_price`
- bid regions below mid
- ask regions above mid
- sequence ordering
- current fill state
- risk-limited bid and ask capacity

Each region is defined by:
- `start_offset`
- `end_offset`
- `density`
- optional top-level hidden take size
- lifespan / expiry

Region offsets are tick distances from the spline mid:
- bid offset `x` maps to `mid_price - x`
- ask offset `x` maps to `mid_price + x`
- `density` is the base-lot size available per tick in the region

For example, a spline with mid `100`, bid region `[1, 3)`, and density `5` exposes:
- `5` lots at `99`
- `5` lots at `98`

An ask region `[1, 3)` on the same spline exposes:
- `5` lots at `101`
- `5` lots at `102`

## How spline levels become visible
A spline level is eligible for the book when:
- the spline is active
- the spline has a nonzero mid price
- the region has not expired
- the region still has unfilled size
- the spline trader has remaining risk capacity on that side

The visible level is the first unfilled tick in the active region. If a tick is partially filled, only the remaining size at that tick is displayed. Once a tick is fully consumed, the next tick in the region becomes visible. Spline liquidity is therefore not a static list of orders. It is derived from the spline's mid price, region definitions, region fill state, expiry, and current risk counters.

## Risk caps
Before matching, Phoenix caps each spline's available bid and ask size using the spline trader's current risk state. The cap accounts for:
- current margin and position state
- `leverage_decrease_in_bps`
- optional max position size limits
- the current risk action

After each spline fill, the in-memory risk counter is decremented. This prevents one instruction from consuming more spline liquidity than the trader can support across multiple price levels.

## Uncrossing and slide prices
Spline liquidity from different traders can cross when their mids and regions overlap. Phoenix resolves this before rendering or matching spline-only liquidity.

The uncross path:
1. Matches crossed splines against FIFO liquidity first when the spline crosses the explicit book.
2. Computes slide prices for remaining crossed spline-only liquidity.
3. Displays and matches more aggressive spline bids at the slide bid.
4. Displays and matches more aggressive spline asks at the slide ask.

Slide prices make the remaining spline book non-crossing without writing synthetic orders into the FIFO book.

## Pro-rata fills
At a single spline price level, FIFO price-time priority does not apply across spline traders. Phoenix allocates the fill pro-rata by available size:

```
allocation = floor(available_lots * fill_size / total_available)
```

Spline sequence number is still used for deterministic iteration and dust handling. It is not the primary priority rule.

Important execution consequences:
- one spline price level consumes one `match_limit` unit, even if multiple splines participate
- one FIFO maker order consumes one `match_limit` unit
- spline liquidity at the same price fills before FIFO liquidity
- worse spline prices do not skip better FIFO prices

## Hidden take size
`top_level_hidden_take_size` is not displayed as normal resting spline liquidity for incoming takers. It is used when a spline itself takes FIFO liquidity during uncrossing. In that path, Phoenix can consume visible size at the current top tick, then hidden take size at that same tick, then visible size through deeper ticks.
