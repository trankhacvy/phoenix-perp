# CLI

Vulcan is the official command-line tool for trading Phoenix perpetual futures. It is designed for both human operators and AI agents, with structured JSON output, a local Model Context Protocol (MCP) server, and bundled skills for popular agent clients.

The Vulcan repository is on GitHub: [Ellipsis-Labs/vulcan-cli](https://github.com/Ellipsis-Labs/vulcan-cli).

**Live commands execute irreversible financial transactions on Solana Mainnet. You are responsible for wallet security, agent permissions, and all trading outcomes.**

## What you can do

- Manage encrypted wallets, register and configure trader accounts, deposit and withdraw collateral.
- Read live market data: prices, orderbooks, candles, funding rates, recent trades.
- Compute technical indicators (RSI, MACD, Bollinger Bands, ATR, VWAP, ADX, Stoch, SMA, EMA) and evaluate triggers.
- Place, cancel, and modify market and limit orders with optional take-profit and stop-loss.
- Monitor and close positions across cross and isolated margin.
- Run first-class strategy loops for TWAP, grid, and TA-driven trading.
- Trade in local paper mode against live prices with no real funds at risk.
- Install agent skills for Claude Code, Cursor, Codex, and other clients, then expose Vulcan tools through a local MCP server.

## Where to go next

- **Installation** — install the binary, configure your wallet, and verify connectivity.
- **Command reference** — every command group with its subcommands and flags.
- **Strategies** — detailed reference for the TWAP, grid, and TA strategy runners.

## Output format

Most commands support `-o table` (default) and `-o json`. Use JSON for scripting and agent integrations; structured command responses use a consistent success/error envelope:

**Success response:**
```json
{ "ok": true, "data": { }, "meta": { } }
```

**Error response:**
```json
{ "ok": false, "error": { "category": "", "code": "", "message": "", "retryable": false } }
```
