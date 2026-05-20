# Glossary

Key Phoenix trading, execution, and risk terms

**Account health:** The overall risk condition of a trader account, computed from effective collateral versus margin thresholds.

**ADL:** Auto-deleveraging. A last-resort mechanism that reduces profitable counterparties when liquidation and backstop paths are not enough.

**Backstop liquidation:** A more severe liquidation path used after the ordinary maintenance/liquidation threshold has already been breached.

**Builder fee:** The additional fee charged when an order is routed through Flight.

**Cancel margin:** The threshold below which Phoenix can force-cancel risk-increasing resting orders.

**Discounted unrealized PnL:** Positive unrealized PnL after applying the market's uPnL risk factor. Negative unrealized PnL is counted in full.

**Effective collateral:** `deposited_collateral + discounted_unrealized_pnl + unsettled_funding`

**Entry price:** The effective average basis of the active position. Phoenix derives it from virtual quote position divided by active base position.

**FIFO order book:** The normal resting order book where better price fills first and equal-price orders fill in time order.

**Funding:** Periodic cash flow between longs and shorts based on mark-index basis.

**High-risk margin:** The deepest standard threshold before ADL-style handling becomes relevant.

**Index price:** The external spot reference used as the anchor for funding and mark-price construction.

**Initial margin:** The collateral requirement to open or safely maintain current exposure, based on leverage tiers and order margin.

**Isolated margin:** A margin mode where a child account has its own dedicated collateral pool.

**Liquidation:** Forced risk reduction once effective collateral falls below maintenance requirements.

**Maintenance margin:** The minimum effective collateral needed before normal liquidation begins.

**Mark price:** The reference price Phoenix uses for PnL, liquidations, funding, and trigger orders.

**Open interest:** The total outstanding long and short exposure in a market.

**Pending funding / unsettled funding:** Funding that has accrued but has not yet been formally settled into collateral.

**PnL:** Profit and loss.

**Risk score:** A numerical health metric used across Phoenix state tooling. Lower is healthier; around `1000` is near liquidation.

**Self-trade prevention:** Matching-engine behavior that prevents a trader from filling against their own resting liquidity.

**Spline liquidity:** Phoenix's region-based liquidity model around a spline mid price.

**Subaccount:** A child account under the same wallet authority. In Phoenix, subaccounts above `0` are used for isolated risk.

**Unrealized PnL:** Profit or loss on an open position at the current mark price.
