# Mark Price

## Calculation
Mark price is calculated as the median of three components:

1. **Adjusted Oracle Price:** Spot oracle price adjusted with a smoothed basis
2. **Book Price:** Median of best bid (highest price someone is willing to pay), best ask (lowest price someone is willing to sell at), and last trade on the Phoenix orderbook (most recent completed transaction price)
3. **Exchange Price:** Weighted median of perpetual prices from major external exchanges

## Design Goals
Phoenix was designed with the following core principles:
- Aim to closely track spot price movements for fair PnL and valuations
- Help protect against manipulation or distortions from temporary liquidity shocks on individual venues
- Seek to reduce the risk of unnecessary liquidation wicks due to short-term anomalies or low-liquidity events such as volatile market conditions, oracle delays, or network issues that may cause deviations
