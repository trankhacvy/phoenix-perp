# Commodities Pricing

## Index Price

### Market Hours

During traditional market hours, the index price is derived directly from the liquid spot and futures markets.

### After Hours

When traditional markets are closed, the index price updates using an exponential moving average (EMA) of the order book impact prices.

With Oracle Price S, Book Impact Price is calculated as:

```
Book impact Price = max(ImpactBid − S, 0) − max(S − ImpactAsk, 0)
```

where ImpactBid and ImpactAsk are the average execution price of respectively buying and selling $1000 notional against the book. Note the value of $1000 is configurable and subject to change.

The Oracle S updates continuously and incrementally using a 1 hour EMA of the current oracle price at time T plus the Book Impact Price at time T+1.

### Transitions

When transitioning from after hours to market hours, the index price instantly snaps to the new external market price. When transitioning from market hours to after hours, the last known external price is the base value for which the EMA is then applied on top of.

## Mark Price

Just as in traditional crypto assets, the Mark Price is calculated as the median of three components.

1. **Adjusted Oracle Price:** Spot oracle price adjusted with a smoothed basis
2. **Book Price:** Median of best bid (highest price someone is willing to pay), best ask (lowest price someone is willing to sell at), and last trade on the Phoenix orderbook (most recent completed transaction price)
3. **Exchange Price:** The spot oracle price plus a 375 slot EMA of the difference between the book mid price and the spot oracle price. During after hours, the EMA is taken over 9000 slots.

Note the third component differs from traditional crypto assets - it replaces the external perp exchange price. Additionally, note the oracle price can either be derived from external sources during market hours or internal pricing during after hours.

## Price Bounds

During after hours, price movements on Phoenix are capped within a range to protect users against oracle price manipulation in lower liquidity hours. The cap is set 1/(max leverage) away from the last known market price - i.e. for GOLD at 25x max leverage, the largest allowed price movement during after hours is 4% away from the last price at market close. The matching engine does not allow trades to be executed outside of the price bounds.
