# Command reference

Every Vulcan CLI command, grouped by topic.

## Global flags

These flags are available on every command:

| Flag | Description |
| --- | --- |
| `-o, --output <format>` | Output format: `table` (default) or `json`. |
| `--dry-run` | Simulate the operation without submitting a transaction. |
| `-y, --yes` | Skip confirmation prompts. |
| `-w, --wallet <name>` | Stored wallet to use instead of the default. |
| `--rpc-url <url>` | Solana RPC endpoint override. |
| `--api-url <url>` | Phoenix API endpoint override. |
| `-v, --verbose` | Enable verbose / debug logging to stderr. |
| `--watch` | Watch for live updates via WebSocket where supported. |

## `wallet` — wallet management

| Subcommand | Description |
| --- | --- |
| `create --name <name>` | Generate a new Solana keypair, encrypt it, and store it. |
| `import --name <name> [--format base58\|bytes\|file] <source>` | Import from base58 string, byte array, or Solana CLI JSON file. |
| `list` | List all stored wallets. |
| `show <name>` | Show wallet details (pubkey, default status). |
| `set-default <name>` | Set a wallet as the default for all commands. |
| `remove <name>` | Remove a wallet from local storage. |
| `export <name> [--file <path> \| --stdout \| --private-key [--private-key-format base58\|bytes]] [--force]` | Export the encrypted wallet file or plaintext private key. |
| `balance [<name>]` | Show SOL and USDC balances. |

## `market` — market data

| Subcommand | Description |
| --- | --- |
| `list` | List all available perpetual markets. |
| `info <symbol>` | Detailed market configuration (tick size, lot size, fees, leverage tiers). |
| `ticker <symbol>` | Current price, 24h volume, open interest, funding rate. |
| `orderbook <symbol> [--depth <n>]` | L2 orderbook snapshot. Default depth 10. |
| `candles <symbol> [--interval <i>] [--limit <n>] [--with-indicators <list>]` | OHLCV candles with optional technical indicators. |
| `trades <symbol> [--limit <n>]` | Recent trades. Default limit 20. |
| `funding-rates <symbol> [--limit <n>]` | Historical funding rates. Default limit 20. |

## `trade` — order management

| Subcommand | Description |
| --- | --- |
| `market-buy <symbol> [<size> \| --tokens <t> \| --notional-usdc <u>]` | Place a market buy. |
| `market-sell <symbol> [<size> \| --tokens <t> \| --notional-usdc <u>]` | Place a market sell. |
| `limit-buy <symbol> <size> <price>` | Place a limit buy. Size in base lots. |
| `limit-sell <symbol> <size> <price>` | Place a limit sell. Size in base lots. |
| `cancel <symbol> <order-id...>` | Cancel specific orders by ID. |
| `cancel-all [<symbol>]` | Cancel all open orders. |
| `orders [<symbol>]` | List open orders. |
| `set-tpsl <symbol> [--tp ...] [--sl ...]` | Set take-profit or stop-loss on an existing position. |
| `cancel-tpsl <symbol> [--tp] [--sl]` | Cancel take-profit and/or stop-loss for a position. |

## `position` — position management

| Subcommand | Description |
| --- | --- |
| `list` | List all open positions. |
| `show <symbol>` | Detailed view of a specific position. |
| `close <symbol>` | Close an entire position. |
| `close-all` | Close every open position across all markets. |
| `reduce <symbol> <size>` | Reduce a position by `size` base lots. |
| `tp-sl <symbol> [--tp <price>] [--sl <price>]` | Attach take-profit and/or stop-loss to an existing position. |

## `margin` — collateral management

| Subcommand | Description |
| --- | --- |
| `status` | Show cross-margin health, equity, maintenance margin, available balance. |
| `deposit <amount>` | Deposit USDC collateral. |
| `withdraw <amount>` | Withdraw USDC collateral. |
| `transfer <amount> --from <idx> --to <idx>` | Transfer collateral between subaccounts. |
| `transfer-child-to-parent --child <idx>` | Sweep all collateral from a child subaccount back to cross-margin. |
| `sync-parent-to-child --child <idx>` | Sync parent state to a child subaccount. |
| `leverage-tiers <symbol>` | Show the leverage tier schedule for a market. |
| `add-collateral <symbol> <amount>` | Add USDC to an isolated position. |

## `account` — trader account

| Subcommand | Description |
| --- | --- |
| `register --access-code <code> \| --referral-code <code> \| --invite-code <code>` | Register a trader account. |
| `info` | Show trader account details (PDA, subaccounts, margin mode). |
| `subaccounts` | List all subaccounts. |
| `create-subaccount [--pda-index <n>] --subaccount-index <n>` | Create a new subaccount. |

## `auth` — Phoenix API authentication

| Subcommand | Description |
| --- | --- |
| `login` | Log in to the Phoenix API by signing a wallet challenge. |
| `status` | Show redacted Phoenix API session status. |
| `logout` | Clear the stored Phoenix API session. |

## `portfolio` — portfolio snapshot

A single command (no subcommands) that returns margin, positions, and open orders in one call.

| Flag | Description |
| --- | --- |
| `--include <sections>` | Comma-separated subset of `margin`, `positions`, `orders`. Defaults to all. |

## `paper` — local paper trading

Paper trading runs against live Phoenix prices but never touches your wallet or on-chain state.

| Subcommand | Description |
| --- | --- |
| `init [--balance <amount>]` | Initialize or overwrite the local paper account. |
| `reset [--balance <amount>]` | Reset local paper state. |
| `status` | Show paper account status. |
| `positions` | Show paper positions. |
| `orders` | Show open paper orders. |
| `fills [--limit <n>]` | Show recent paper fills. Default limit 50. |
| `buy <symbol> [--type market\|limit] [--size <lots> \| --tokens <t> \| --notional-usdc <u>]` | Place a paper buy order. |
| `sell <symbol> [--type market\|limit] [--size <lots> \| --tokens <t> \| --notional-usdc <u>]` | Place a paper sell order. |
| `cancel <order-id>` | Cancel a paper order. |
| `cancel-all [<symbol>]` | Cancel all paper orders. |
| `reconcile [<symbol>]` | Reconcile resting paper limit orders against live market prices. |

## `history` — trade and account history

| Subcommand | Description |
| --- | --- |
| `trades [--symbol <s>] [--limit <n>]` | Past trade and fill history. Default limit 20. |
| `orders [--symbol <s>] [--limit <n>]` | Past order history. Default limit 20. |
| `collateral [--limit <n>]` | Deposit and withdrawal history. Default limit 20. |
| `funding [--symbol <s>] [--limit <n>]` | Funding payment history. Default limit 20. |
| `pnl [--resolution hourly\|daily] [--limit <n>]` | PnL over time. Defaults to `hourly`, limit 24. |

## `agent` — agent setup

| Subcommand | Description |
| --- | --- |
| `install [--target <t>] [--scope user\|project]` | Install Vulcan agent skills for a client. |
| `doctor [--target <t>]` | Inspect known agent skill locations. |
| `health [--target <t>]` | Combined health check for first-run agent guidance. |
| `mcp install [--target <t>] [--dangerous]` | Install or update the Vulcan MCP config. |
| `mcp set-wallet <wallet> [--target <t>]` | Switch the wallet used by an already-installed Vulcan MCP server. |
| `mcp diagnose [--target <t>]` | Spawn the server and verify `vulcan_*` tools appear. |
| `log show [--limit <n>]` | Show recent redacted action log records. |
| `log summary [--limit <n>]` | Summarize recent actions, positions, PnL, errors, and transactions. |
| `log report [--limit <n>]` | Build a position and session report from live trader state and local logs. |

## `strategy` — strategy runners

Long-running TWAP, grid, and TA strategy runners with ledger-backed pause / resume / finalize lifecycle.

| Subcommand | Description |
| --- | --- |
| `twap start ...` | Start a TWAP run. |
| `twap resume <run-id> [--from-step <n>]` | Resume a paused or incomplete TWAP run. |
| `grid start ...` | Start a grid trading run. |
| `grid resume <run-id> [--from-step <n>]` | Resume a paused or incomplete grid run. |
| `ta start ...` | Start a TA-driven strategy run from a config file or JSON. |
| `ta resume <run-id>` | Resume a paused or incomplete TA run. |
| `runs [--limit <n>]` | List persisted strategy runs. |
| `status <run-id>` | Show latest status for a run. |
| `monitor <run-id>` | Compact non-blocking monitor state. |
| `pause <run-id> [--reason <r>]` | Request a running strategy to pause at the next safe point. |
| `stop <run-id> [--reason <r>]` | Request a strategy to stop permanently at the next safe point. |
| `finalize <run-id>` | Stop a strategy and optionally clean up live orders or positions. |
| `preflight` | Inspect live-readiness for the active wallet. |

## `ta` — technical analysis

| Subcommand | Description |
| --- | --- |
| `compute <symbol> --indicator <name> [--timeframe <tf>]` | Compute a single indicator over the latest candles. |
| `signal <symbol> --spec <json>` | Evaluate a trigger spec against the latest indicator value. |
| `report <symbol> [--timeframe <tf>]` | Multi-indicator snapshot (RSI, MACD, BBands, ATR, ADX). |

## Standalone commands

| Command | Description |
| --- | --- |
| `status` | Check configuration, connectivity, wallet, and registration status. |
| `setup` | Interactive setup wizard for wallet, config, and connectivity. |
| `version` | Print version and build information. |
| `update check [--force]` | Check whether a newer Vulcan release is available. |
| `agent-context` | Print agent runtime context (CONTEXT.md) to stdout. |
| `mcp [--allow-dangerous]` | Start the local MCP server over stdio. |
