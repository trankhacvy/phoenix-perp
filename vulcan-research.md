# Vulcan CLI — Deep Research Report

## 1. What Vulcan Is

Vulcan is a Rust-based AI-native command-line interface and MCP (Model Context Protocol) server for trading perpetual futures on **Phoenix DEX** (Solana). Its distinguishing design goal is to be equally usable by human traders typing commands and by AI agents making tool calls — every error, output envelope, and execution report is engineered for machine consumption first, human readability second.

Default mode is **paper-safe**: market data and simulated trading work without any wallet. Live trading is an explicit opt-in gated by wallet decryption and a dangerous-tool flag.

**Version**: 0.6.2  
**License**: MIT  
**Author**: Ellipsis Labs (Phoenix DEX team)

---

## 2. Repository Layout

```
vulcan-cli/
├── vulcan/                      # Binary crate (CLI entry point)
│   ├── src/main.rs              # Arg parsing, command dispatch, MCP launch
│   ├── src/bin/gen_tool_catalog.rs  # Regenerates agents/tool-catalog.json
│   └── tests/cli_integration.rs # Integration tests against real binary
│
├── vulcan-lib/                  # Library crate (all business logic)
│   └── src/
│       ├── lib.rs               # Module declarations
│       ├── context.rs           # AppContext (shared app state)
│       ├── config/              # ~/.vulcan/config.toml parsing
│       ├── error.rs             # VulcanError, ErrorCategory, exit codes
│       ├── auth.rs              # Phoenix API session authentication
│       ├── secrets.rs           # SecretString (zeroized, redacted wrappers)
│       ├── crypto/              # AES-256-GCM + Argon2id wallet encryption
│       ├── wallet/              # Encrypted keypair storage
│       ├── cli/                 # Clap-derive structs only (no logic)
│       ├── commands/            # 19 command handlers
│       ├── strategy/            # TWAP, Grid, TA strategy runners
│       ├── indicators/          # Technical analysis indicator engine
│       ├── paper/               # Paper trading simulation engine
│       ├── history/             # Trade/order history pagination
│       ├── mcp/                 # MCP server, tool registry, catalog gen
│       ├── output/              # JSON envelope + table rendering
│       ├── agent_log.rs         # Append-only session action log
│       ├── agent_install_state.rs  # Persists last install target/scope
│       └── watch.rs             # WebSocket live data subscriptions
│
├── agents/                      # Machine-readable agent contracts
│   ├── system.md                # Fallback system prompt (non-MCP agents)
│   ├── tool-catalog.json        # Auto-generated MCP tool registry
│   ├── error-catalog.json       # Error codes + recovery hints
│   ├── strategy-template.md     # Template for new strategy runners
│   └── README.md                # Documentation ownership model
│
├── skills/                      # 18 workflow skill documents
│   ├── INDEX.md                 # Skill index
│   └── vulcan-*/SKILL.md        # Per-task AI workflow guides
│
├── scripts/
│   ├── install.sh               # One-line install with SHA256 verification
│   ├── vulcan_smoke.py          # Live trading smoke test
│   ├── paper_smoke.py           # Paper mode smoke test (32 scenarios)
│   └── paper_mcp_smoke.py       # MCP JSON-RPC transport smoke test
│
├── .claude-plugin/plugin.json   # Claude Code plugin (userConfig + keychain)
├── .cursor-plugin/plugin.json   # Cursor IDE plugin
├── .codex-plugin/plugin.json    # Codex plugin (richest metadata)
├── gemini-extension.json        # Gemini extension
├── .mcp.json                    # Minimal MCP config for direct invocation
├── CONTEXT.md                   # Canonical runtime contract for AI agents
├── AGENTS.md                    # Integration guide for MCP clients
├── CLAUDE.md                    # Contributor guide
├── flake.nix                    # Nix cross-compile environments
├── deny.toml                    # Cargo dependency audit config
└── rust-toolchain.toml          # Pins stable Rust channel
```

---

## 3. Technology Stack

| Layer | Technology |
|---|---|
| Language | Rust (stable channel, edition 2021) |
| CLI parsing | Clap 4 with derive macros |
| Async runtime | Tokio 1.44 (multi-thread, macros, sync, time) |
| Blockchain | Solana SDK 2.3–2.4, Phoenix Rise SDK 0.1.2 |
| HTTP client | Reqwest 0.12 |
| Serialization | Serde 1 + serde_json (preserve_order) + TOML 0.8 |
| Encryption | AES-GCM 0.10 + Argon2 0.5 (Argon2id) |
| Secret handling | Zeroize 1, Rpassword 5 |
| MCP protocol | RMCP 1.2 (server + stdio transport) |
| Schema gen | Schemars 1.0 (JSON Schema from Rust types) |
| Technical analysis | Kand 0.2 |
| Output formatting | Comfy-table 7, Colored 2 |
| Error handling | Thiserror 2, Anyhow 1 |
| Logging | Tracing 0.1 + tracing-subscriber 0.3 |
| Time | Chrono 0.4 |
| Versioning | Semver 1 |
| Directories | Dirs 5 |
| Build tooling | Nix flake, cross-compile via nixpkgs |

---

## 4. Architecture Overview

### Two-Crate Design

**`vulcan` (binary)**: Only knows about CLI arguments and dispatch. No business logic lives here.

**`vulcan-lib` (library)**: All business logic, Phoenix SDK integration, MCP server, strategies, paper engine, wallet storage, and output formatting.

### AppContext — The Dependency Container

Every command receives an `AppContext` by reference:

```
AppContext {
    config: VulcanConfig            // loaded from ~/.vulcan/config.toml
    wallet_store: WalletStore       // encrypted wallets on disk
    output_format: OutputFormat     // JSON or table
    vulcan_dir: PathBuf             // ~/.vulcan
    dry_run, yes, verbose, watch    // CLI flag overrides
    wallet_override                 // --wallet flag (ignored in MCP)
    http_client: PhoenixHttpClient  // authenticated or public
    raw_http_client: reqwest::Client
    session_id: String              // stable per-invocation identifier
    agent_log: Option<AgentLogSink> // append-only action log
    session_wallet: Option<SessionWallet>  // pre-decrypted in MCP mode
    metadata: OnceCell<PhoenixMetadata>    // lazy-loaded on first use
}
```

Metadata (markets, tickers, leverage tiers) is cached in a `OnceCell` and fetched exactly once per session.

### Command Dispatch Flow

```
main() (vulcan/src/main.rs)
  ├── Parse CLI args (Clap)
  ├── Initialize tracing subscriber
  ├── Build AppContext from config + flags
  ├── Auto-login Phoenix API (if needed for command)
  ├── Dispatch to command handler (async)
  ├── Log result to agent_log
  └── Render output → stdout; diagnostics → stderr
```

### Output Contract

Every command produces a typed struct serialized to one of two shapes:

```json
// Success
{ "ok": true, "data": { ... }, "meta": { ... } }

// Failure  
{ "ok": false, "error": { "category": "network", "code": "API_TIMEOUT", "message": "...", "retryable": true } }
```

Table format renders the same data as `comfy-table` with UTF8_FULL preset.

---

## 5. Configuration

**File**: `~/.vulcan/config.toml`

```toml
[network]
rpc_url = "https://api.mainnet-beta.solana.com"
api_url = "https://perp-api.phoenix.trade"
api_key = "..."  # optional

[wallet]
default = "my-wallet"

[output]
format = "table"   # or "json"
color = true

[trading]
default_slippage_bps = 50
confirm_trades = true

[agent_log]
enabled = true
max_summary_entries = 50
retain_sessions = 20
max_file_mb = 25
```

CLI flags (`--rpc-url`, `--api-url`, `--wallet`) override config at runtime. Environment variables `VULCAN_WALLET_NAME` and `VULCAN_WALLET_PASSWORD` inject wallet credentials in non-interactive MCP mode.

---

## 6. Command Inventory (18 groups)

### Trading & Positions

| Command | Description |
|---|---|
| `vulcan trade market-buy/sell` | Market order; sizing via `--size` (lots), `--tokens`, or `--notional-usdc` |
| `vulcan trade limit-buy/sell` | Limit order with optional TP/SL bracket |
| `vulcan trade multi-limit` | Multi-level limit orders (bids + asks arrays); expands per-leg when any has TP/SL |
| `vulcan trade cancel` | Cancel order(s) by ID |
| `vulcan trade cancel-all` | Cancel all orders (optionally filtered by symbol) |
| `vulcan trade orders` | List open orders; fallback to legacy HTTP path |
| `vulcan trade set-tpsl` | Attach multi-level TP/SL to existing position |
| `vulcan trade cancel-tpsl` | Cancel TP/SL triggers |
| `vulcan position list` | All open positions across all subaccounts |
| `vulcan position show` | Detailed position + TP/SL triggers |
| `vulcan position close` | Market close; auto-sweeps isolated collateral |
| `vulcan position close-all` | Flatten all positions sequentially |
| `vulcan position reduce` | Partial reduction by base lots |
| `vulcan position tp-sl` | Attach TP/SL to existing position |

### Market Data

| Command | Description |
|---|---|
| `vulcan market list` | All available perpetual markets |
| `vulcan market info` | tick_size, base_lots_decimals, fees, leverage tiers |
| `vulcan market ticker` | Mark price, oracle, 24h change/volume, funding rate |
| `vulcan market orderbook` | Bid/ask levels with spread_bps |
| `vulcan market candles` | OHLCV (1m/5m/15m/1h/4h/1d), optional indicator overlay |
| `vulcan market trades` | Recent fills |
| `vulcan market funding-rates` | Funding rate history |

### Margin & Account

| Command | Description |
|---|---|
| `vulcan margin status` | Collateral, effective_collateral, portfolio_value, risk_state, available_to_withdraw |
| `vulcan margin deposit` | Deposit USDC from wallet |
| `vulcan margin withdraw` | Withdraw USDC |
| `vulcan margin transfer` | Move collateral between subaccounts |
| `vulcan margin add-collateral` | Add to isolated position's subaccount |
| `vulcan margin leverage-tiers` | Max leverage and max size per symbol |
| `vulcan account register` | Register trader with access/referral code |
| `vulcan account info` | Account collateral, portfolio value, risk state |
| `vulcan account subaccounts` | List subaccounts (cross + isolated) |
| `vulcan portfolio` | Combined snapshot: margin + positions + orders |

### Strategy Runners

| Command | Description |
|---|---|
| `vulcan strategy twap start` | TWAP execution across configurable slices |
| `vulcan strategy grid start` | Grid trading with layered limit orders |
| `vulcan strategy ta start` | Technical analysis rule-driven execution |
| `vulcan strategy runs` | Recent strategy runs |
| `vulcan strategy status` | Run progress, lifecycle status |
| `vulcan strategy monitor` | Runner lock, event summary, terminal status |
| `vulcan strategy wait-next-tick` | Poll for next tick or terminal status |
| `vulcan strategy report` | Full run report from ledger |
| `vulcan strategy finalize` | Stop + optional cancel/close |
| `vulcan strategy preflight` | Pre-launch readiness check |
| `vulcan strategy pause/stop` | Control running strategy |

### Technical Analysis

| Command | Description |
|---|---|
| `vulcan ta compute` | Single indicator computation |
| `vulcan ta signal` | Trigger spec evaluation (e.g. `rsi crosses_below 30`) |
| `vulcan ta report` | Bundled RSI + MACD + BBands + ATR + ADX |

### Paper Trading

| Command | Description |
|---|---|
| `vulcan paper init` | Initialize paper account with balance/fee_bps |
| `vulcan paper status` | Balance, equity, PnL, exposure ratio |
| `vulcan paper buy/sell` | Market or limit order against live prices |
| `vulcan paper cancel` | Cancel paper order |
| `vulcan paper cancel-all` | Cancel all paper orders |
| `vulcan paper reconcile` | Match pending orders against historical candles |
| `vulcan paper set-tpsl` | Attach TP/SL to paper position |
| `vulcan paper cancel-tpsl` | Cancel TP/SL triggers |
| `vulcan paper triggers` | List active conditional triggers |

### Infrastructure

| Command | Description |
|---|---|
| `vulcan wallet create` | Generate new keypair, encrypt with password |
| `vulcan wallet import` | Import from base58 or Solana JSON file |
| `vulcan wallet list` | List stored wallets |
| `vulcan wallet balance` | SOL + USDC balance via RPC |
| `vulcan wallet export` | Export private key (requires `--yes`) |
| `vulcan auth login` | Authenticate Phoenix API session via wallet signature |
| `vulcan auth status` | Session validity and metadata |
| `vulcan auth logout` | Clear session file |
| `vulcan history trades` | Paginated trade fills |
| `vulcan history orders` | Order history |
| `vulcan history collateral` | Collateral history |
| `vulcan history funding` | Funding payment history |
| `vulcan history pnl` | Hourly PnL |
| `vulcan agent install` | Install skill SKILL.md files to agent target |
| `vulcan agent mcp install` | Wire MCP server into agent client config |
| `vulcan agent mcp doctor` | Diagnose MCP server (JSON-RPC probe) |
| `vulcan agent health` | Full diagnostic: connectivity, wallets, trader, skills |
| `vulcan agent live-ready` | Readiness check for live trading |
| `vulcan agent log` | Show/summarize/report session action log |
| `vulcan setup` | Interactive first-run wizard |
| `vulcan status` | Quick diagnostic snapshot |
| `vulcan update` | Check for newer version on GitHub Releases |
| `vulcan mcp` | Launch MCP server (stdio transport) |

---

## 7. MCP Server

### Architecture

The MCP server is launched via `vulcan mcp`. It speaks JSON-RPC over stdio and registers all Vulcan tools under the naming convention `vulcan_<group>_<action>` (e.g. `vulcan_trade_market_buy`, `vulcan_margin_status`).

Two modes:

- **Default (read-only/paper-safe)**: No wallet needed. Dangerous tools are hidden from the tool list.
- **`--allow-dangerous`**: Unlocks wallet from `VULCAN_WALLET_PASSWORD` env var (or prompts on interactive stdin). Exposes dangerous tools but each requires `acknowledged: true` in the call.

### Session Wallet

When `--allow-dangerous` is set, the wallet is decrypted once at startup into a `SessionWallet` struct held in `AppContext`. All tool invocations in that session reuse the same pre-decrypted signer — no per-call password prompt.

### Tool Catalog

`agents/tool-catalog.json` is auto-generated from `ToolDef` structs in `vulcan-lib/src/mcp/registry.rs` by running:

```sh
cargo run -p vulcan --bin gen_tool_catalog > agents/tool-catalog.json
```

A unit test enforces the checked-in file matches the generator. CI fails if it drifts.

### Agent Client Integrations

| Client | Config location | Auth mechanism |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | `userConfig` (keychain-backed password) |
| Cursor | `.cursor-plugin/plugin.json` | Env vars set manually |
| Codex | `.codex-plugin/plugin.json` | Env vars |
| Gemini | `gemini-extension.json` | Env vars |
| Generic | `.mcp.json` | No auth (read-only default) |

The Claude plugin is the most sophisticated: it declares a `userConfig` schema with `wallet_name` and `wallet_password` fields (password marked sensitive), which Claude Code stores in the host keychain and injects as env vars when launching the MCP server.

---

## 8. Strategy Runners

All three runners share a common framework: persistent ledger, watchdog, detached execution, and agent monitoring contract.

### Common Infrastructure

**Execution Modes:**
| Mode | Description |
|---|---|
| Paper | Local simulation, no blockchain |
| DryRun | Plans printed, no transactions submitted |
| ConfirmEach | Real funds, per-action user approval |
| AutoExecute | Real funds, autonomous within safety gates |

**Ledger system** (file-based persistence):
- `{run_id}.ledger.json` — full slice/step history with status progression
- `{run_id}.summary.json` — computed report
- `{run_id}.jsonl` — per-tick snapshots (market, position, execution, progress)

**Slice status lifecycle**: `Planned → Ready → Submitted → Resting → Filled | Partial | Cancelled | Finalized`

**Watchdog** (`strategy/watchdog.rs`): tokio task that monitors runner liveness via last-tick timestamp:
- Stage 1 (at `stale_after_seconds`): writes `Stop` control request to `{run_id}.control.json`
- Stage 2 (at `2x stale_after_seconds`): marks ledger `errored` if runner still unresponsive
- Default stale threshold: `max(interval_seconds * 2, 180)`

**Detached monitoring contract for agents:**
- `strategy start` returns `run_id` immediately
- Agent calls `vulcan_strategy_monitor` for checkpoint status
- Agent calls `vulcan_strategy_wait_next_tick` for tick-anchored wake scheduling (`next_tick.next_tick_at` not wall-clock time)
- Loop continues until terminal status (completed/stopped/errored) or stale lifecycle

### TWAP Strategy

Time-weighted average price execution distributing total notional across N equal time-spaced slices.

**Key parameters**: symbol, side, total_tokens/notional, slices, interval_seconds, run_label, mode  
**Safety defaults**: max_total_notional_usdc=1000, max_step_notional_usdc=100, max_price_drift_bps=100

**Pre-execution**: margin feasibility check (validates position fits margin tiers), collateral presence  
**Per-tick render** (8 required fields): header, market snapshot, planned vs executable, execution result, cumulative progress, position, account health, next tick  
**Sub-minute cadence** supported (foreground mode only)

### Grid Strategy

Level-based entry/exit with layered limit orders across a price range.

**Key parameters**: symbol, price range (lower/upper), levels per side, tokens per level, optional TP/SL spacing  
**Level replacement logic**: when a buy level fills → place corresponding sell one level higher; vice versa  
**Bracket orders**: per-level TP/SL brackets pinned to position base_lots  
**Worst-case margin**: all buy OR all sell levels fill simultaneously  
**Preflight**: validates full grid margin requirement

### Technical Analysis (TA) Strategy

Declarative rule-based strategy. Config defines `rules[]`, each with a condition tree and action.

**Rule anatomy**:
```json
{
  "name": "rsi-entry",
  "condition": { "op": "lt", "indicator": "rsi", "period": 14, "threshold": 30 },
  "action": { "type": "open", "side": "buy", "size_tokens": 0.5 },
  "cooldown": "until_condition_resets",
  "position_filter": "flat"
}
```

**Condition operators**: `lt`, `lte`, `gt`, `gte`, `crosses_above`, `crosses_below`, `all`, `any`, `not`  
**Actions**: `open`, `close`, `reduce`, `no_op`  
**Cooldown policies**: `none`, `until_condition_resets`, `once_per_run`, `min_ticks`  
**Position filters**: `any`, `long`, `short`, `flat`, `not_flat`  
**Cadence modes**: `fixed` (sleep N seconds) or `candle_close` (wake after bar close + grace)  
**Risk monitoring**: per-tick leverage, liquidation price, liquidation distance, margin state  
**First-firing-wins**: rules evaluated top-down; first matching rule executes and remaining are skipped that tick

---

## 9. Technical Indicators

**Library**: Kand 0.2 (Rust TA library)

**Supported indicators**:
- SMA, EMA, RSI, MACD, Bollinger Bands, ATR, VWAP, ADX, Stochastic

**Warmup requirements** (minimum candles before non-NaN values):
| Indicator | Minimum candles |
|---|---|
| SMA/EMA/RSI/ATR/BBands | period + 1 |
| MACD | 35 |
| ADX | period × 2 + 1 |
| Stoch | period + 3 |

**Trigger operations**: `lt`, `lte`, `gt`, `gte`, `crosses_above` (prev ≤ threshold, current > threshold), `crosses_below`

**`ta report`**: bundled snapshot of RSI + MACD + BBands + ATR + ADX, default timeframe 1h

---

## 10. Paper Trading Engine

The paper engine (`vulcan-lib/src/paper/`) provides a complete simulation with persistent state at `~/.vulcan/paper.json`.

**State model**:
```
PaperState {
    balance: f64           // USDC
    positions: []          // open positions per symbol/side
    orders: []             // resting limit orders
    fills: []              // historical fills (capped)
    triggers: []           // TP/SL triggers
}
```

**Order lifecycle**: Market orders fill immediately at mid-price. Limit orders rest until `reconcile` is called.

**Reconcile**: Fetches candles since last reconcile (up to 30 days), replays each candle:
1. Checks if any resting limit order crossed by the candle's high/low
2. Checks if any TP/SL trigger was hit
3. Uses bullish/bearish heuristic for sequencing within a candle (e.g. long candle: low fills buy stops before high fills sell stops)
4. Cascades TP/SL deletion when position closes

**Order-time TP/SL**: Attaching TP/SL at order placement time creates "pending" triggers — they activate only after the parent order fills.

**Fee accounting**: `fee_bps` applied to every fill; accumulated in `fees_paid` counter.

**32 paper smoke scenarios** verify: account lifecycle, order placement (market/limit/sizing paths), position arithmetic (extend, flip, partial close), fee charging, TP/SL order-time/resting/cascade, trigger fire on reconcile, candle replay, grid bracket re-parenting.

---

## 11. Wallet & Cryptography

### Storage

Wallets stored as encrypted blobs at `~/.vulcan/wallets/{name}.wallet`:
```
Base64(salt ++ nonce ++ AES-256-GCM(keypair_bytes))
```

Key derivation: Argon2id (19456 KiB memory, 3 iterations, parallelism=1)

### SecretString

All passwords and private keys in memory are wrapped in `SecretString`:
- `Debug` → `"SecretString([REDACTED])"`
- `Display` → `"[REDACTED]"`
- `Serialize` → `"[REDACTED]"` (safe to log structs containing secrets)
- `Zeroize` on drop (memory cleared)

### Session Wallet

In MCP mode, the wallet is decrypted once at startup into `SessionWallet`. All tool calls reuse the same signer. No per-call password prompt.

### Private Key Export

`vulcan wallet export --private-key` requires `--yes` flag. The `CONTEXT.md` contract explicitly forbids agents from executing this command.

---

## 12. Authentication

Phoenix API sessions use wallet-signature authentication:

1. `GET /v1/auth/nonce/{wallet_pubkey}` → nonce
2. Sign message containing nonce with wallet keypair
3. `POST /v1/auth/login` → session token
4. Store to `~/.vulcan/auth/session.json` (handled by Phoenix Rise SDK's `FileAuthSessionStore`)

Session metadata (wallet address, name, `logged_in_at`) stored separately at `~/.vulcan/auth/session-meta.json`.

`AppContext` builds the HTTP client at startup. If no session exists or it's invalid, the client falls back to public (unauthenticated) mode with a non-fatal error message. Commands that need authentication surface this error.

**Auto-login**: `auto_login_if_possible()` attempts login without user interaction (MCP mode). Skipped if already valid/refreshable. Requires `VULCAN_WALLET_PASSWORD` or interactive terminal.

---

## 13. Error Handling System

### Error Categories (10 variants)

| Category | Exit Code | Retryable | Description |
|---|---|---|---|
| Validation | 1 | No | Bad input, wrong size units, missing args |
| Auth | 2 | No | Wallet/password/permission errors |
| Config | 3 | No | Missing or malformed config |
| Api | 4 | No | Phoenix API/exchange errors |
| Network | 5 | Yes | Transient connectivity |
| RateLimit | 6 | Yes | API rate limit hit |
| TxFailed | 7 | No | On-chain transaction failure |
| Io | 8 | Yes | File system errors |
| DangerousGate | 9 | No | Missing `acknowledged: true` |
| Internal | 10 | No | Bug/unexpected state |

### Recovery Hints

Each `VulcanError` carries a `recovery_hint()` — context-sensitive text for agent self-service recovery. For example, `NO_DEFAULT_WALLET` → `"Run: vulcan wallet set-default <NAME>"`.

### Common Error Codes

`UNKNOWN_MARKET`, `MISSING_ARG`, `NO_POSITION`, `ISOLATED_ONLY_MARKET`, `NO_DEFAULT_WALLET`, `DECRYPT_FAILED`, `NO_TRADER_ACCOUNT`, `CONFIG_ERROR`, `REGISTER_API_FAILED`, `BUILD_TPSL_FAILED`, `WALLET_PASSWORD_REQUIRED`

---

## 14. Agent Architecture — Skills & Contracts

### Document Ownership Model

| Document | Audience | Purpose |
|---|---|---|
| `CONTEXT.md` | AI agents (runtime) | Canonical contract: tools, safety rules, execution reporting, error handling |
| `skills/vulcan/SKILL.md` | Skill-capable agents | Entry skill, directs to sub-skills |
| `skills/vulcan-*/SKILL.md` | AI agents (task-specific) | 18 workflow guides |
| `agents/system.md` | Non-MCP agents | Fallback system prompt |
| `agents/tool-catalog.json` | AI agents | Machine-readable tool registry |
| `agents/error-catalog.json` | AI agents | Error codes, categories, recovery hints |
| `AGENTS.md` | Humans integrating Vulcan | MCP setup, agent wiring |
| `CLAUDE.md` | Contributors | Architecture, conventions, safety rules |
| `README.md` | Public | Install, quick start, command reference |

### 18 Bundled Skills

| Skill | Purpose |
|---|---|
| `vulcan` | Entry skill, directs to sub-skills |
| `vulcan-quickstart` | Five-minute install + first paper trade |
| `vulcan-onboarding` | Health check → paper path → wallet → live |
| `vulcan-execution-modes` | Canonical mode taxonomy (Observe→Paper→Dry-Run→Confirm-Each→Auto-Execute) |
| `vulcan-risk-management` | Pre-trade checks, leverage tiers, margin thresholds |
| `vulcan-trade-execution` | Safe market/limit order flow |
| `vulcan-lot-size-calculator` | Token → base lots conversion (most common agent mistake) |
| `vulcan-tpsl-management` | TP/SL at order time, on existing positions, multi-level |
| `vulcan-position-management` | List, show, close, reduce, TP/SL |
| `vulcan-margin-operations` | Deposit, withdraw, transfer, isolated margin |
| `vulcan-market-intel` | Ticker, orderbook, candles, pre-trade analysis |
| `vulcan-portfolio-intel` | Full portfolio snapshot, presentation template |
| `vulcan-technical-analysis` | Indicators, trigger evaluation, report |
| `vulcan-twap-execution` | TWAP strategy: pre-checks, per-tick render, agent monitoring |
| `vulcan-grid-trading` | Grid: price range → level placement → replacement loop |
| `vulcan-ta-strategy` | TA-rule strategy: condition trees, cooldown, position filters |
| `vulcan-scale-orders` | Laddered limits: TA-suggested ranges, per-level TP/SL models |
| `vulcan-error-recovery` | Error category routing, tx_failed recovery, backoff |

### Critical Agent Safety Rules (from CONTEXT.md)

1. All dangerous operations require explicit approval (`acknowledged: true` MCP or `--yes` CLI)
2. Call `vulcan_market_info` before using base-lot size (each market has different decimals)
3. Call `vulcan_margin_status` before opening positions
4. Call `vulcan_position_list` before trading
5. Never guess lot sizes
6. Report every trade/order/cancel/TP-SL/margin action as it occurs — never batch
7. Agents must not execute private key export
8. Never read MCP config files for `VULCAN_WALLET_PASSWORD`

---

## 15. Agent Action Log

The agent log (`~/.vulcan/agent-actions.jsonl`) is an append-only JSONL file recording every command execution:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "session_id": "abc123",
  "correlation_id": "xyz",
  "surface": "mcp",
  "name": "trade.market_buy",
  "dangerous": true,
  "acknowledged": true,
  "outcome": "success",
  "duration_ms": 450,
  "error_code": null,
  "args": { "symbol": "SOL", "side": "buy", "size": 100 },
  "summary": { "order_id": "...", "filled_tokens": "1.0" }
}
```

**Redaction**: Sensitive fields (`password`, `api_key`, `private_key`) are stripped. Trading context (`symbol`, `side`, `order_type`) is preserved.

**Retention**: Configurable by session count (default 20) or file size (default 25 MB). Removed sessions are archived to `agent-session-summaries.jsonl`.

**Session report** (`vulcan agent log report`): builds position/action/fill summaries from logs + live portfolio state. Computes: action counts (trades, cancels, closes, reductions), mode split (live/dry-run/paper), win rate, unique transaction signatures.

---

## 16. CI/CD & Build

### GitHub Actions Workflows

**`build.yaml`**: On every push/PR:
- `cargo check` (macOS + Linux)
- `cargo nextest` (test suite with CI profile)
- `cargo clippy -D warnings`
- `nightly rustfmt` format check
- Cross-build (calls `cross-build.yaml`)
- All-checks-passed gate job

**`cross-build.yaml`**: Multi-platform compilation via Nix develop shells:
- x86_64-linux (musl static), aarch64-linux (musl static)
- x86_64-darwin (Intel Mac), aarch64-darwin (Apple Silicon)
- Artifacts retained 5 days

**`publish.yaml`**: On git tag `v*`:
1. Validate tag matches `Cargo.toml` version
2. Full test suite → cross-build (gated)
3. Prepare release assets: tar.gz per platform, SHA256 checksums, templated `install.sh`
4. Create GitHub release

### Install Script

```sh
curl -fsSL https://raw.githubusercontent.com/Ellipsis-Labs/vulcan-cli/main/scripts/install.sh | sh
```

- Platform autodetection (4 targets)
- GitHub Releases download with SHA256 verification
- Optional agent skill installation (claude/cursor/codex/agentskills targets)
- Configurable via `VULCAN_VERSION`, `VULCAN_INSTALL_DIR`, `VULCAN_INSTALL_AGENT_SKILLS` env vars

### Update Detection

`vulcan update` checks `https://api.github.com/repos/Ellipsis-Labs/vulcan-cli/releases/latest` with 6-hour cache. Classifies install method:

| Method | Detection |
|---|---|
| PackageManager | Homebrew, Nix store, snap, flatpak, non-user-writable paths |
| InstallScriptDefault | `~/.local/bin/vulcan` |
| InstallScriptCustomDir | Other user-writable directories |

Generates appropriate update command based on method. Restart hint: "If a vulcan MCP server is running, restart that session — the live process keeps using the old binary."

---

## 17. Safety Architecture

Vulcan applies defense-in-depth at every layer:

### Secrets
- `SecretString` redacts in Debug/Display/Serialize
- Argon2id key derivation for wallet encryption
- Session wallet pre-decrypted at startup, never re-decrypted per-call
- `VULCAN_WALLET_PASSWORD` from environment or host keychain — never from disk

### Dangerous Gate
- MCP default: dangerous tools hidden from tool list
- `--allow-dangerous` flag required at server startup
- Each dangerous tool call requires `acknowledged: true` parameter
- CLI: `--yes` required for all mutating operations

### Pre-trade Checks
Preflight (`vulcan strategy preflight`) validates:
1. Wallet selection and password availability
2. Trader registration on Phoenix
3. Collateral presence and available margin
4. Margin feasibility against leverage tiers
5. MCP target scanning for live signing capability

### Strategy Safety Defaults
```
max_total_notional_usdc: 1000    # hard cap on total execution
max_step_notional_usdc:  100     # per-slice cap
max_price_drift_bps:     100     # launch-anchored drift protection
max_exposure_ratio:      3.0     # position leverage cap
```

### Integration Tests (Hostile Environment)
`vulcan/tests/cli_integration.rs` runs the real binary with stripped env vars and non-existent HOME:
- `version_succeeds_with_minimal_env`: basic CLI works without setup
- `live_mcp_without_password_fails_fast`: `WALLET_PASSWORD_REQUIRED` error includes both remedies
- `paper_safe_mcp_starts_and_lists_only_non_dangerous_tools`: default `vulcan mcp` hides dangerous tools

---

## 18. Key Design Principles

1. **Agent-first, human-compatible**: Every error code, output envelope, and recovery hint designed for machine parsing first
2. **Paper-safe default**: Live trading is explicit opt-in; market data and simulation work with zero setup
3. **Deterministic error model**: Category → exit code mapping is stable and documented; retryability is explicit
4. **Graduated execution modes**: Observe → Paper → Dry-Run → Confirm-Each → Auto-Execute with mandatory mode question before any strategy touching real funds
5. **Lazy initialization**: Phoenix metadata fetched once and cached; auth sessions loaded only when needed
6. **Execution reporting contract**: Every trade, order, cancel, and margin action reported immediately — never batched mid-run
7. **Lot-size discipline**: `base_lots_decimals` varies by market; the `vulcan-lot-size-calculator` skill exists specifically because agents frequently get this wrong
8. **Secret zeroization**: Private keys and passwords cleared on drop throughout
9. **Tool catalog as single source of truth**: `tool-catalog.json` auto-generated from Rust source; CI enforces it never drifts
10. **Watchdog-backed strategies**: All detached runners have a two-stage escalation watchdog; agents monitor via polling `next_tick.next_tick_at`, not wall-clock time
