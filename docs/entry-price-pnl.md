# Entry Price And PnL

How Phoenix tracks entry price, unrealized PnL, and realized PnL.

## Overview

Phoenix derives entry price from the open position's base size and virtual quote position.

For an open position:

```
entry_price = abs(virtual_quote_lot_position) / abs(base_lot_position)
```

If `base_lot_position` is zero, the position has no active entry price.

## When Entry Price Changes

Entry price changes when a fill increases exposure.

- If you are flat or long and buy more, Phoenix recalculates the long entry price
- If you are flat or short and sell more, Phoenix recalculates the short entry price
- Maker, taker, and spline fills follow the same accounting rules

Reducing a position does not change the remaining entry price. It realizes PnL on the closed portion and preserves the average basis for the open remainder.

A full close removes the entry price. A flip through zero creates a new entry price for the residual position.

## PnL

### Unrealized PnL

Unrealized PnL is based on mark price versus entry price:

```
unrealized_pnl = position_size * (mark_price - entry_price)
```

- Long positions gain when mark price rises
- Short positions gain when mark price falls

### Realized PnL

Realized PnL is created when a fill reduces, closes, or flips an existing position.

## What Does Not Change Entry Price

The following do not change entry price by themselves:

- Placing a resting limit order
- Funding settlement
- Trading fees
- Builder fees

Funding and fees affect collateral separately. They are not included in `virtual_quote_lot_position`.

If an opposite-side limit order rests, entry price is unchanged. If it executes, the filled portion follows the normal fill rules above.
