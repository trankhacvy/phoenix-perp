# Accounts

## Overview
Phoenix separates a wallet authority from its trader accounts. The wallet signs transactions. Trader accounts hold collateral, positions, and resting orders. Each trader account is a program-derived address (PDA) derived from:
- wallet authority
- `portfolio_index`
- `subaccount_index`

The pair `(portfolio_index, subaccount_index)` defines which account is being addressed for that authority.

## Portfolio index
`portfolio_index` partitions a wallet's Phoenix state into independent portfolios. Each `portfolio_index` has its own collateral, positions, orders, and risk. Positions and collateral in one portfolio do not margin positions in another portfolio. This lets a single wallet authority maintain separate trading books without sharing collateral or liquidation risk between them.

## Subaccount index
Within a portfolio, `subaccount_index` selects either the cross account or an isolated account.

### Cross account
`subaccount_index = 0` is the cross account for the portfolio. The cross account uses one shared collateral pool across its active positions. PnL, funding, margin requirements, and order margin all affect the same account health.

Capacity limits:
- up to `128` active positions
- up to `64` resting bid limit orders per market
- up to `64` resting ask limit orders per market

### Isolated accounts
`subaccount_index > 0` is an isolated account under the same portfolio. An isolated account is used for a single isolated position. Collateral is moved from the portfolio's cross account into the isolated account when the isolated position is opened or funded. The isolated account has its own collateral and liquidation boundary. Losses in the isolated account do not automatically draw from the cross account after collateral has been allocated. When the isolated position is closed, a crank can sweep remaining collateral back from the isolated account to the portfolio's cross account.

## Account model
For a given wallet authority:
- `(portfolio_index = 0, subaccount_index = 0)` is the first portfolio's cross account
- `(portfolio_index = 0, subaccount_index > 0)` is an isolated account under the first portfolio
- `(portfolio_index = 1, subaccount_index = 0)` is a separate cross account with independent collateral and positions
- `(portfolio_index = 1, subaccount_index > 0)` is an isolated account under that separate portfolio

The important boundary is the `portfolio_index`. Subaccounts inside one portfolio relate to that portfolio's cross account. Different portfolios do not share margin.
