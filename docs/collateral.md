# Collateral

## Overview
Phoenix perps are currently margined in USDC. Deposits, withdrawals, margin checks, PnL, and funding all resolve against the account's USDC collateral balance.

## Collateral asset
Phoenix currently supports USDC as its only collateral asset. Other collateral assets may be added in the future. Solana USDC is deposited through the Ember contract first before it reaches the Phoenix exchange. Ember wraps Solana USDC `1:1` into Phoenix's exchange-side collateral representation. Withdrawals perform the reverse conversion.

## Ember
Ember is the proxy contract between standard Solana USDC and Phoenix collateral.

### Deposits:
1. USDC moves from your wallet token account into Ember.
2. Ember wraps the same atomic amount `1:1`.
3. Phoenix credits the collateral to your trader account.

### Withdrawals:
1. Phoenix withdraws collateral from your trader account.
2. Ember unwraps the same atomic amount `1:1`.
3. USDC returns to your wallet.

Ember does not set exchange rates, apply haircuts, or introduce another collateral asset. The amount transferred into Ember is the amount credited through the wrapper. The amount burned on withdrawal is the amount released back as Solana USDC.

## Account collateral and effective collateral
`deposited_collateral` is the USDC collateral balance credited to a Phoenix trader account.

`effective_collateral` is the collateral value Phoenix uses for risk checks. It includes deposited collateral, unsettled funding, and unrealized PnL:
```
effective_collateral = deposited_collateral + unrealized_pnl + unsettled_funding
```

Effective collateral is not a separate balance or token. It is the margin value used for health checks, liquidations, and withdrawal eligibility.

## Withdrawals
Phoenix rate-limits protocol-wide collateral outflows with a global withdraw queue. The queue applies to exchange-wide withdrawals, not just activity on one account.

- A withdrawal clears immediately if the queue is empty and the request fits within the current withdrawal budget.
- Otherwise, the withdrawal is queued.
- Queued withdrawals are processed in FIFO order as budget replenishes over time.
- Queued withdrawals are not partially filled.
- If the account no longer has enough withdrawable collateral when the request reaches the front of the queue, the request can be dropped instead of processed.

## Reference

### Contract and mint addresses
- Ember program id: `EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy`
- Wallet USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Phoenix USDC mint: `PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A`

### Current withdraw parameters
Snapshot verified from live mainnet exchange accounts on `2026-04-20`:
- `max_budget`: `2,000,000` Phoenix USDC
- `replenish_amount_per_slot`: `450` Phoenix USDC per slot
- `withdrawal_fee`: `0`
- `enqueueing_fee`: `0`
- `deposit_cooldown_period_in_slots`: `0`
