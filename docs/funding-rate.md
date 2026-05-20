# Funding Rate

## How It Works

**Formula:** `Funding = (Mark Price - Index Price) × Rate`

- **When Mark > Index:** Longs pay shorts (incentivizes selling, reduces perp price)
- **When Mark < Index:** Shorts pay longs (incentivizes buying, raises perp price)

## Settlement
- Funding accumulates continuously based on hourly snapshots and settles every 24 hours
- Pending funding (but unsettled) can affect account health/liquidation risk in real time
- The maximum funding rate is clamped per market. The percentage is dependent on mark price and can be found in the Market Parameters.

When a trader interacts with the protocol, their pending funding is calculated as:
```
funding_payment = (current_accumulator - snapshot_accumulator) × position_size
```
