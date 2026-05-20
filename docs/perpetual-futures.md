# Perpetual Futures

## Overview
Perpetual futures are leveraged contracts that track an underlying asset without an expiry date. Phoenix uses them to let traders:
- go long or short with posted collateral
- trade against both resting limit orders and fast-updating spline liquidity
- keep positions open indefinitely as long as margin stays healthy

## What makes a perp different from spot

In spot trading, you buy or sell the asset itself. In perps, you trade synthetic exposure instead:
- PnL is driven by mark-price changes versus your entry price
- leverage is created by posting only a fraction of notional as collateral
- funding transfers value between longs and shorts to keep the market anchored
- liquidation rules enforce solvency when collateral is no longer sufficient

## The core moving parts

### Entry price and PnL
Every position has an effective entry price and then accumulates unrealized PnL as mark price moves. See Entry Price And PnL.

### Mark price
Phoenix uses a robust mark price instead of the last trade price. It combines an adjusted oracle price, Phoenix order book data, and external perpetual prices so risk checks are anchored to a fair market estimate rather than a single venue or transient fill. See Mark Price.

### Funding
Because perps have no expiry, funding is the mechanism that keeps the perp aligned with the underlying market over time. See Funding Rate.

### Margin
Margin lets traders take larger positions than their posted collateral alone would otherwise support, while accepting liquidation risk if losses, funding, or changing risk requirements erode the account's collateral. See Accounts and Margin Math.

### Liquidations and ADL
If effective collateral falls below maintenance margin, Phoenix first attempts normal liquidation through the order book after cancelling risk-increasing open orders. If the account remains underwater, liquidation can escalate to a backstop transfer, and finally ADL can be used last to close the remaining risk against profitable traders on the opposite side to preserve the exchange's health. See Liquidations.

## How to navigate the docs from here
- Start with Accounts if you need the wallet and trader-account model
- Read Matching Engine if you want to understand fills
- Read Margin Math if you want to understand liquidation risk
- Use Market Parameters once the earlier concepts are familiar
