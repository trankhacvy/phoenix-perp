# Fees

## Overview
Phoenix charges trading fees on matched notional.

## Base trading fees
- taker fee: `3.5 bps` (`0.035%`)
- maker fee: `0.5 bps` (`0.005%`)

Examples:
- `$10,000 * 0.035% = $3.50` taker fee
- `$10,000 * 0.005% = $0.50` maker fee

## Maker vs taker
- you are a maker when your order provides resting liquidity
- you are a taker when your order removes existing liquidity

A limit order can be either:
- taker on the crossed portion
- maker on any remainder that rests

## What else can affect your all-in cost

### Referral discount
Referral codes can reduce user trading fees. See Referral Program.

### Flight builder fee
If you route an order through Flight, the builder fee is additive to exchange trading fees. See Flight.
