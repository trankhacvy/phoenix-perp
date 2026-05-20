# Installation

Install the Vulcan CLI and set up your wallet, configuration, and agent integrations.

## Prerequisites

- macOS or Linux.
- `~/.local/bin` on your `PATH` (the default install location).
- A Solana wallet, or you can let Vulcan generate one during setup.

## Install the latest release

```
curl -fsSL https://github.com/Ellipsis-Labs/vulcan-cli/releases/latest/download/install.sh | sh
```

The installer downloads the release archive, verifies it against `vulcan-checksums-sha256.txt`, and installs the binary to `~/.local/bin/vulcan` by default. Set `VULCAN_INSTALL_DIR` before running to install elsewhere.

## Install a specific version

Replace the tag with any tagged release:

```
curl -fsSL https://github.com/Ellipsis-Labs/vulcan-cli/releases/download/v0.5.3/install.sh | sh
```

## Build from source

Requires Rust 1.84 or newer. From a clone of [Ellipsis-Labs/vulcan-cli](https://github.com/Ellipsis-Labs/vulcan-cli):

```
cargo install --path vulcan
```

## Verify

```
vulcan version
```

## First-run setup

Run the interactive wizard to configure your wallet, RPC and API endpoints, registration, and optional first deposit:

```
vulcan setup
```

Then confirm everything is wired up:

```
vulcan status -o json
```

## Configuration file

Vulcan reads `~/.vulcan/config.toml`. A typical configuration looks like:

```toml
[network]
rpc_url = "https://api.mainnet-beta.solana.com"
api_url = "https://perp-api.phoenix.trade"
# api_key = "your-api-key"

[wallet]
default = "my-wallet"

[trading]
default_slippage_bps = 50
confirm_trades = true
```

Any of `rpc_url`, `api_url`, or the default wallet can be overridden per-command with the matching global flag (`--rpc-url`, `--api-url`, `-w/--wallet`).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `VULCAN_WALLET_NAME` | Stored wallet to use (defaults to the configured default wallet). |
| `VULCAN_WALLET_PASSWORD` | Wallet unlock password. Required for non-interactive MCP sessions. |
| `VULCAN_INSTALL_DIR` | Custom install directory used by the install script. |
| `VULCAN_AGENT_TARGET` | Default agent client target for `vulcan agent install`. |
| `VULCAN_AGENT_SCOPE` | Default install scope: `user` or `project`. |

## Agent skills

Vulcan ships bundled skill files that teach AI agents how to use it safely. Install them for your client:

```
vulcan agent install --target claude
vulcan agent install --target cursor
vulcan agent install --target codex
vulcan agent install --target agentskills
```

Supported targets: `claude`, `cursor`, `codex`, `agentskills`. Add `--scope project` for project-local installs where the target supports it.

Inspect what is currently installed:

```
vulcan agent doctor --target claude
vulcan agent health
```

End-to-end probe — spawn the server with the exact command and env an agent client would use and assert that `vulcan_*` tools come back:

```
vulcan agent mcp diagnose --target claude --scope user
```

If you migrate to a new Vulcan binary path and want to update `command` / `args` in an existing MCP entry without re-entering your wallet password:

```
vulcan agent mcp install --target claude --scope user --repair
```

## MCP server

Vulcan can run as a local Model Context Protocol (MCP) server over stdio so agents can call its tools directly. Private keys never leave the local Vulcan process.

Read-only / paper-safe:

```
vulcan mcp
```

Live-capable:

```
export VULCAN_WALLET_NAME=my-wallet
export VULCAN_WALLET_PASSWORD=your-password
vulcan mcp --allow-dangerous
```

To have an agent client launch the MCP server automatically, install an MCP config:

```
vulcan agent mcp install --target cursor --scope user
vulcan agent mcp install --target cursor --scope user --dangerous
```

The `--dangerous` form prompts for wallet name and password, then writes the values into the agent client's MCP config.

To switch the wallet used by an already-installed MCP server:

```
vulcan agent mcp set-wallet <wallet-name> --target claude --scope user
```
