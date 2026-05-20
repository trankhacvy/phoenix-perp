# Account Health

## Overview
Phoenix expresses risk both as named tiers and as a numerical risk score.

## Risk tiers

| Tier | Meaning |
| --- | --- |
| `Safe` | Effective collateral is above initial margin |
| `AtRisk` | Below initial margin but not yet cancellable |
| `Cancellable` | Risk-increasing resting orders can be force-cancelled |
| `Liquidatable` | Market-order liquidation can begin |
| `BackstopLiquidatable` | The account is beyond normal liquidation comfort |
| `HighRisk` | Deeply stressed and potentially ADL-eligible |

## Risk score
A common Phoenix state score is:
- if maintenance margin is `0`, score is `0`
- if effective collateral is positive, score is approximately `(maintenance_margin / effective_collateral) * 1000`
- if effective collateral is zero or negative, score rises above `1000` with an underwater penalty

Interpretation:
- lower is healthier
- around `1000` means the account is at or through the liquidation boundary
- above `1000` means the account is underwater

## What improves health
- adding collateral
- reducing positions
- cancelling risk-increasing resting orders
- receiving positive funding
- positive mark-price movement on your exposure

## What worsens health
- adverse price moves
- paying funding
- adding more size
- placing more risk-increasing orders
- moving collateral out of the account

## Why the same position can have a different health state tomorrow
Because health is portfolio-aware and dynamic:
- mark price changes
- funding changes
- other positions in cross margin change
- positive-uPnL credit can be discounted
