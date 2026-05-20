# Risk Tiers And Liquidation

## Overview
Phoenix classifies trader accounts by comparing effective collateral against margin thresholds. As collateral falls, the account moves into progressively more severe risk tiers. Each tier gives the protocol stronger tools to reduce risk.

## Risk tiers

| Tier | Status | Condition | Action |
| --- | --- | --- | --- |
| 0 | Low Risk | Effective collateral ≥ initial margin | No immediate action |
| 1 | At Risk | Effective collateral < initial margin and > cancel margin | Monitored |
| 2 | Cancellable | Effective collateral ≤ cancel margin and > maintenance margin | Risk-increasing limit orders can be cancelled |
| 3 | Liquidatable | Effective collateral < maintenance margin | Positions are eligible for market liquidation |
| 4 | BackstopLiquidatable | Effective collateral < backstop threshold | Backstop liquidation can transfer distressed risk |
| 5 | High Risk | Effective collateral < high-risk threshold | ADL eligible |

## Liquidation types

### Market liquidation
For liquidatable accounts, Phoenix can reduce positions through market execution.
- executes against available liquidity
- can be partial
- must improve trader health or fully close the position
- respects market liquidation size limits

### Backstop liquidation
If market liquidation is not enough, Phoenix can transfer a distressed position to a backstop account.
- the backstop account absorbs the position
- the backstop account then unwinds the risk through normal market execution
- this path is used when orderbook liquidity is insufficient or the account is too distressed for ordinary liquidation

### ADL
ADL is the last-resort path.
- the losing position is matched against a profitable trader on the opposite side
- the highest-priority profitable trader is selected first
- the match closes or reduces both sides
- profitable traders affected by ADL may realize less profit than expected
