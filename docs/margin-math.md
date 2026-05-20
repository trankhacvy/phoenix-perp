# Margin Math

## Overview
Phoenix evaluates each trader account as a single margin account. Positions, funding, unrealized PnL, and risk-increasing resting orders all feed into the same account health calculation.

Margin is the mechanism that lets traders take positions larger than their posted collateral while keeping the exchange solvent. A perp venue always has a long and a short side for the same open interest. When one side has unrealized profit, the other side has the matching liability. The risk system is designed to keep those liabilities collateralized and to make sure risky positions can be reduced before they create bad debt.

At a high level:
```
account_health = effective_collateral - margin_requirement
```

If effective collateral falls through the risk thresholds, Phoenix can cancel risk-increasing orders, liquidate through the order book, escalate to backstop liquidation, and finally use ADL.

## Risk invariants
Phoenix margin is built around three practical invariants:
- long and short open interest must balance
- unrealized profits must be matched by liabilities elsewhere in the system
- those liabilities must remain collateralized

If a losing account can no longer cover the unrealized profit owed to the other side, the system has bad debt. Margin requirements, mark prices, funding, liquidation thresholds, and open interest controls all exist to reduce the probability of that outcome.

## Effective collateral
Effective collateral is the collateral value Phoenix uses for risk checks. It is similar to account equity, but Phoenix can discount positive unrealized PnL before treating it as usable collateral.

```
effective_collateral = deposited_collateral
  + discounted_positive_unrealized_pnl
  + negative_unrealized_pnl
  + unsettled_funding
```

Important details:
- deposited collateral is the USDC collateral balance on the trader account
- positive unrealized PnL can be discounted by the market's `uPnL risk factor`
- negative unrealized PnL counts in full
- unsettled funding is included because it changes account risk before final settlement

Phoenix discounts positive uPnL to reduce the risk that manipulated or unstable mark prices create too much usable collateral. This matters more for volatile or lower-liquidity assets, where mark prices can be easier to move temporarily.

## Mark price and PnL
Position value is based on mark price, not the last trade price.

```
unrealized_pnl = position_size * (mark_price - entry_price)
```

Using mark price for PnL, margin, and liquidation checks helps prevent a single trade or thin order book from pushing accounts into unsafe states.

## Position margin
For each market, Phoenix calculates margin from the absolute position size and the market's leverage tier.

```
position_notional = abs(position_size) * mark_price

position_margin = position_notional / max_leverage_for_size
```

The leverage tier is selected from the resulting position size. A fill that moves the total position into a different tier can change margin for the whole resulting position, not only the newest fill.

## Limit-order margin
Risk-increasing resting limit orders can require margin before they fill. Phoenix evaluates resting bids and resting asks separately for each market:

```
market_initial_margin = position_margin
  + max(bid_side_margin_increase, ask_side_margin_increase)
```

This matters because a trader cannot fill every bid and every ask in the same market into the same final directional exposure. Phoenix therefore reserves margin for the worse side, not the sum of both sides.

## Maintenance margin and other thresholds
Phoenix derives lower risk thresholds from initial margin using market-specific risk factors. These thresholds are the escalation ladder the protocol uses as an account becomes more dangerous to the system.

```
cancel_margin = initial_margin * cancel_order_risk_factor

maintenance_margin = initial_margin * maintenance_risk_factor

backstop_requirement = initial_margin * backstop_risk_factor

high_risk_margin = initial_margin * high_risk_factor
```

Initial margin is the opening and healthy-account requirement. Maintenance margin is the main liquidation threshold. If effective collateral falls below maintenance margin, the account can be liquidated.

The broader risk sequence is:
- below cancel margin: risk-increasing limit orders can be cancelled
- below maintenance margin: market liquidation can begin
- below backstop requirement: distressed positions can be transferred to a backstop account
- below high-risk margin: ADL can become available
