# Matching Engine

## Overview
Phoenix builds one matching view from two liquidity sources.

## Liquidity surfaces

### FIFO order book
The FIFO order book is the standard limit-order book. Orders fill by price first, then by time priority within the same price level.

### Spline liquidity
Spline liquidity is virtual liquidity published by authorized spline traders. A spline trader quotes a mid price and bid/ask regions around that mid. The engine materializes those regions into visible price levels when it builds the combined book. For each interaction, the engine builds a combined view over both sources. It loads the FIFO bid and ask maps, loads eligible splines, applies spline risk caps and current-slot fill state, and then matches against the best available price across the combined book.

## Fast quote updates
Splines are designed to let market makers move liquidity with very low compute overhead. On a traditional FIFO book, a market maker that wants to move an entire quote ladder has to place and cancel many individual limit orders. A multi-limit-order transaction can cost up to roughly `300,000` compute units. With spline liquidity, the market maker can update the spline's reference price and move the quoted regions around that price. A spline oracle update costs around `600` compute units.

That compute asymmetry matters for market structure. When external prices move, stale on-chain quotes are vulnerable to toxic taker flow. Lower-cost spline updates let market makers refresh quotes more quickly and more frequently, which helps them quote tighter spreads without pricing in as much stale-quote risk. This does not guarantee transaction ordering. It gives quote updates a much smaller compute footprint, which improves the economics and latency profile of keeping Phoenix liquidity close to the current market. Spline traders can also attach their own sequence numbers to updates, so stale updates can be rejected if validators reorder multiple spline updates from the same trader.

## Execution priority
The engine uses price priority across FIFO and spline liquidity:
- for an incoming buy, the lower ask fills first
- for an incoming sell, the higher bid fills first
- if FIFO and spline liquidity are available at the same price, spline liquidity fills first

Equal-price spline priority does not let deeper spline liquidity skip better FIFO prices. When splines win priority at a price, the engine only matches spline levels up to the current FIFO boundary before returning to FIFO.

## High-level flow
1. A user submits an order packet.
2. The engine validates price, size, flags, expiry, and self-trade behavior. If the order can rest, it also checks the trader's per-side open-order cap before placement.
3. The engine builds the combined matching view.
4. The order matches eligible FIFO or spline liquidity until the order is filled, price-limited, budget-limited, or match-limited.
5. Any remaining size rests on the FIFO book, expires, or is discarded depending on the order packet.

## What changes fill behavior
- whether the incoming order crosses the combined BBO
- `self_trade_behavior`
- `match_limit`
- post-only slide or reject behavior
- execution price band filtering
- current spline risk counters
- whether a spline-only cross has been resolved into slide prices
