# Leverage Tiers

Market-specific leverage tiers that affect collateral requirements.

## Overview

Phoenix uses market-specific leverage tiers.

As position size increases, the market may require more collateral for the same notional exposure. Smaller positions can receive higher max leverage. Larger positions may receive lower max leverage.

## How Tiers Affect Margin

Initial margin is based on position size, mark price, and the max leverage available at that size:

```
initial_margin = position_notional / max_leverage
```

If a fill increases your total position size into a lower-leverage range, Phoenix recalculates margin for the full resulting position, not only the newest fill.

Reducing position size can lower margin because:

- The notional position is smaller
- The remaining size may qualify for higher max leverage

## Resting Orders

Risk-increasing resting limit orders can also reserve margin before they fill.

Phoenix evaluates whether resting bids or asks could increase exposure. If they can, the account may need additional collateral even though the orders have not executed yet.

Reduce-only orders do not add exposure.

## Live Tier Values

Leverage tiers are market-specific and can change.

Use Market Parameters for current tier values, including:

- Max leverage
- Max size
- Limit order risk factor
