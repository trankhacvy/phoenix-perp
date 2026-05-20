# Phoenix Market Parameters

## Overview

This page pulls the full market parameter set from `https://perp-api.phoenix.trade/exchange/markets`. If that request fails, it falls back to the bundled snapshot in `phoenix/market-parameters-fallback.json` and keeps retrying in the background.

## Summary

| Market | Base Lot Size | Tick Size | OI Cap (Base) |
| --- | --- | --- | --- |
| SOL | 0.01 | $0.010000 | 120,000 SOL |
| BTC | 0.0001 | $1.000000 | 135 BTC |
| ETH | 0.001 | $0.100000 | 1,000 ETH |
| AAVE | 0.01 | $0.010000 | 10,000 AAVE |
| BNB | 0.01 | $0.010000 | 770 BNB |
| CHIP | 1 | $0.000010 | 4,929,990 CHIP |
| DOGE | 1 | $0.000001 | 5,391,650 DOGE |
| ENA | 1 | $0.000010 | 4,369,870 ENA |
| FARTCOIN | 1 | $0.000010 | 2,489,790 FARTCOIN |
| GOLD | 0.001 | $0.100000 | 675 GOLD |
| HYPE | 0.01 | $0.001000 | 40,000 HYPE |
| JTO | 0.1 | $0.000100 | 746,270 JTO |
| JUP | 1 | $0.000010 | 2,070,620 JUP |
| LIT | 0.1 | $0.000100 | 862,069 LIT |
| MEGA | 1 | $0.000010 | 2,766,100 MEGA |
| MET | 1 | $0.000010 | 2,070,620 MET |
| MON | 1 | $0.000001 | 14,120,300 MON |
| NEAR | 1 | $0.000100 | 369,030 NEAR |
| PUMP | 100 | $0.000000 | 273,224,000 PUMP |
| SILVER | 0.01 | $0.001000 | 11,250 SILVER |
| SKR | 1 | $0.000001 | 14,000,000 SKR |
| SUI | 1 | $0.000010 | 513,750 SUI |
| TAO | 0.001 | $0.100000 | 1,470 TAO |
| TON | 0.1 | $0.000100 | 504,566.3 TON |
| VVV | 0.01 | $0.001000 | 29,570 VVV |
| WTIOIL | 0.01 | $0.010000 | 9,500 WTIOIL |
| XPL | 1 | $0.000010 | 4,826,250 XPL |
| XRP | 0.01 | $0.001000 | 815,000 XRP |
| ZEC | 0.01 | $0.010000 | 5,214.58 ZEC |

Each market includes leverage tiers, funding rates, risk factors, fees, margin requirements, and associated market and spline account addresses.

Markets marked as "Isolated Only" include GOLD, SILVER, SKR, and WTIOIL.
