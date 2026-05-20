# FAQ

Answers to the most common execution, margin, and account questions

## Why can effective collateral differ from my deposited collateral?

Effective collateral is the value Phoenix uses for risk checks. It is not a separate balance or token.

At a high level:

```
effective_collateral = deposited_collateral + discounted_positive_unrealized_pnl + negative_unrealized_pnl + unsettled_funding
```

Deposited collateral is the USDC collateral balance on the trader account. Positive unrealized PnL may be discounted before it counts toward margin, negative unrealized PnL counts in full, and unsettled funding can move effective collateral up or down before it is reflected as settled collateral.

See [Collateral](/phoenix/collateral-and-accounts/collateral) for the account-level collateral model and [Margin Math](/phoenix/margin-and-risk/margin-math) for the risk calculation.

## Do subaccounts share risk?

It depends on the account type.

Within a portfolio, `subaccount_index = 0` is the cross account. Positions, collateral, funding, PnL, and resting-order margin all feed into one shared account health calculation.

`subaccount_index > 0` is used for isolated accounts. Collateral is moved from the portfolio's cross account into the isolated account, and that isolated account has its own liquidation boundary. Losses in the isolated account do not automatically pull more collateral from the cross account after collateral has been allocated. Unused or remaining collateral in the isolated account may be swept back to the cross account.

Different `portfolio_index` values are separate portfolios. They do not share collateral, positions, or liquidation risk.

See [Accounts](/phoenix/collateral-and-accounts/accounts) for the full account model.

## Are builder fees the same as trading fees?

No. Flight builder fees are separate from Phoenix maker/taker fees and are additive when an order is routed through a builder.

See [Fees](/phoenix/matching-engine/fees) and [Flight](/phoenix/flight).

## Why does positive PnL not fully count toward margin?

Positive unrealized PnL is not the same as deposited collateral. It depends on the current mark price, and that mark can move.

Phoenix can discount positive unrealized PnL before counting it toward effective collateral. Negative unrealized PnL counts in full.

The discount reduces the risk that unstable or manipulated mark prices create too much usable collateral. This matters more for volatile or lower-liquidity assets, where mark prices can be easier to move or temporarily distorted, so the market-specific discount can differ by asset. Market-specific `uPnL risk factor` values are shown in [Market Parameters](/phoenix/market-parameters).

See [Margin Math](/phoenix/margin-and-risk/margin-math) for the effective collateral calculation.

## Why did my liquidation price move when I did not touch that market?

Liquidation price is an estimate, not a fixed promise.

Phoenix estimates liquidation price from your collateral, position size, entry price, mark price, leverage tier, funding, and the rest of the account. In cross margin, other positions can change effective collateral and maintenance requirements, so the estimated liquidation price for one market can move even if you did not trade that market.

Common reasons it moves:

- Mark price changes
- Funding accrues or settles
- Another cross-margin position gains or loses value
- Resting risk-increasing orders change margin requirements
- The market's leverage tier or risk parameters change

See [Margin Math](/phoenix/margin-and-risk/margin-math), [Mark Price](/phoenix/margin-and-risk/mark-price), and [Funding](/phoenix/margin-and-risk/funding-rate).

## Why was my resting order cancelled before I was liquidated?

Phoenix can cancel risk-increasing resting limit orders before liquidating filled positions.

This can happen when effective collateral falls below cancel margin. A resting order is risk-increasing if it could add exposure or increase required margin when filled. Cancelling it can improve account health without touching open positions.

See [Risk Tiers And Liquidation](/phoenix/margin-and-risk/liquidations), [Account Health](/phoenix/margin-and-risk/account-health), and [Leverage Tiers](/phoenix/margin-and-risk/leverage-tiers).

## What is the difference between liquidation and ADL?

- liquidation tries to close the risky account through normal market or backstop paths
- ADL reduces profitable counterparties when the exchange needs a stronger last-resort protection

See [Risk Tiers And Liquidation](/phoenix/margin-and-risk/liquidations).
