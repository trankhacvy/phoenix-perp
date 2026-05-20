# Strategies

Vulcan's `strategy` command group hosts long-running execution loops that are too stateful for one-shot orders. Each run is ledger-backed, supports `pause` / `resume` / `finalize` lifecycle commands, and can be started in detached mode so the runner keeps ticking in the background. Tick logs and ledgers are persisted under `~/.vulcan/strategy-runs`.

Three runners ship today:

- **TWAP** — split a target size across timed slices.
- **Grid** — maintain layered limit orders across a price band.
- **TA** — rule-based runner over technical indicators for entry and exit.

## Execution modes

Every strategy accepts `--mode`. Pick the one that matches your tolerance for live risk while testing:

| Mode | Behavior |
| --- | --- |
| `paper` | Simulated against live prices. No wallet or chain activity. Default. |
| `dry-run` | Builds and logs each step but does not submit transactions. |
| `confirm-each` | Submits live orders, prompting for confirmation before each step. |
| `auto-execute` | Submits live orders without prompting. Use with guardrails. |

## Margin mode

For TWAP and grid runs, `--margin-mode` selects how collateral is held:

| Mode | Behavior |
| --- | --- |
| `cross` | Uses the trader's main cross-margin account. Default. |
| `isolated` | Opens an isolated subaccount. Pair with `--isolated-collateral` for the opening deposit. |

## Guardrails

All three runners accept the same safety flags. Any breach pauses the run and records the reason in the ledger:

| Flag | Description |
| --- | --- |
| `--max-total-notional-usdc <amount>` | Cap on total live notional placed by the run. |
| `--max-step-notional-usdc <amount>` | Cap on a single tick's live notional. |
| `--max-price-drift-bps <bps>` | Pause if mark price drifts this far from the run-start price. |
| `--max-exposure-ratio <ratio>` | Pause if position notional / equity exceeds this ratio. |
| `--reconcile-attempts <n>` | Number of history reconciliation attempts per live step. |
| `--reconcile-delay-ms <ms>` | Milliseconds between reconciliation attempts. |

## TWAP

TWAP slices a target size across N equally spaced intervals so each fill nudges the average price toward the time-weighted mean.

### `vulcan strategy twap start`

| Flag | Description |
| --- | --- |
| `--symbol <s>` | Market symbol (e.g. `SOL`). |
| `--side <buy\|sell>` | Trade direction. |
| `--notional-usdc <amount>` | Total TWAP notional in USDC. Mutually exclusive with `--tokens`. |
| `--tokens <amount>` | Total TWAP size in base-asset tokens. Mutually exclusive with `--notional-usdc`. |
| `--slices <n>` | Number of slices. |
| `--interval-seconds <s>` | Seconds between slices. Default `60`. |
| `--mode <m>` | Execution mode. Default `paper`. |
| `--margin-mode <m>` | Margin mode. Default `cross`. |
| `--isolated-collateral <amount>` | USDC to transfer when opening the first isolated live order. |
| `--run-label <label>` | Optional human-readable label stored with the run. |
| `--detached` | Start the runner in the background and return immediately with the run ID. |

Plus the guardrail flags above.

### `vulcan strategy twap resume`

```
vulcan strategy twap resume <run-id> [--from-step <n>]
```

Resume a paused or incomplete TWAP run, optionally starting at a specific step.

### Example

```
vulcan strategy twap start \
  --symbol SOL \
  --side buy \
  --notional-usdc 5000 \
  --slices 10 \
  --interval-seconds 300 \
  --mode auto-execute \
  --max-step-notional-usdc 600 \
  --max-price-drift-bps 75 \
  --detached
```

## Grid

Grid trading lays buy levels below the mark and sell levels above the mark, then maintains the ladder as fills happen. The runner can either be bounded by `--ticks` or run indefinitely with `--run-until-stopped`.

### `vulcan strategy grid start`

| Flag | Description |
| --- | --- |
| `--symbol <s>` | Market symbol (e.g. `SOL`). |
| `--lower-price <p>` | Lower grid boundary price. Required unless `--center-on-mark` is set. |
| `--upper-price <p>` | Upper grid boundary price. Required unless `--center-on-mark` is set. |
| `--center-on-mark` | Center the grid on the current mark price at launch. Requires `--width-pct`. |
| `--width-pct <pct>` | Half-width of the grid as a percentage of mark (e.g. `1.0` = ±1%). Requires `--center-on-mark`. |
| `--levels-per-side <n>` | Number of buy levels below mark and sell levels above mark. |
| `--tokens-per-level <t>` | Order size per level in base-asset tokens. Mutually exclusive with `--size-lots-per-level`. |
| `--size-lots-per-level <n>` | Order size per level in base lots. Mutually exclusive with `--tokens-per-level`. |
| `--bid-level PRICE:SIZE_LOTS[:TP][:SL]` | Fully custom bid level. Repeatable, replaces generated bids. |
| `--ask-level PRICE:SIZE_LOTS[:TP][:SL]` | Fully custom ask level. Repeatable, replaces generated asks. |
| `--take-profit-spacing <p>` | Distance from entry to take-profit for generated levels. |
| `--stop-loss-spacing <p>` | Distance from entry to stop-loss for generated levels. |
| `--interval-seconds <s>` | Seconds between maintenance ticks. Default `60`. |
| `--ticks <n>` | Maximum ticks to run, including the initial placement tick. Default `60`. |
| `--run-until-stopped` | Keep running maintenance ticks until paused or stopped. |
| `--stale-after-seconds <s>` | Seconds without a tick before status reports this run as stale. |
| `--mode <m>` | Execution mode. Default `paper`. |
| `--margin-mode <m>` | Margin mode. Default `cross`. |
| `--isolated-collateral <amount>` | USDC to transfer when opening the first isolated live order. |
| `--run-label <label>` | Optional human-readable label. |
| `--slide` | Allow live multi-limit orders to slide to the top of book if crossing. |
| `--detached` | Start in the background and return immediately with the run ID. |

Plus the guardrail flags above.

### `vulcan strategy grid resume`

```
vulcan strategy grid resume <run-id> [--from-step <n>]
```

Resume a paused or incomplete grid run.

### Example

```
vulcan strategy grid start \
  --symbol SOL \
  --center-on-mark \
  --width-pct 2.5 \
  --levels-per-side 5 \
  --tokens-per-level 0.5 \
  --run-until-stopped \
  --mode auto-execute \
  --max-total-notional-usdc 10000 \
  --detached
```

## TA

The TA runner evaluates rules of the form `(condition, action)` over indicator values on a chosen timeframe. Conditions reference indicators like `rsi`, `macd`, `ema`, etc.; actions place or close positions when triggered. Configs are JSON, supplied inline or via a file. TA margin settings are part of that JSON config (`margin_mode` and `isolated_collateral`), not separate CLI flags.

### `vulcan strategy ta start`

| Flag | Description |
| --- | --- |
| `--config-file <path>` | Path to a JSON config file. Mutually exclusive with `--config-json`. |
| `--config-json <json>` | Inline JSON config. Mutually exclusive with `--config-file`. |
| `--mode <m>` | Execution mode. Default `paper`. |
| `--max-ticks <n>` | Maximum ticks to run. Ignored when `--run-until-stopped` is set. Default `60`. |
| `--run-until-stopped` | Keep running until paused or stopped. |
| `--run-label <label>` | Optional human-readable label. |
| `--detached` | Start in the background and return immediately with the run ID. |

Plus the guardrail flags above.

### `vulcan strategy ta resume`

```
vulcan strategy ta resume <run-id>
```

Resume a paused or incomplete TA strategy run.

### Example

```
vulcan strategy ta start \
  --config-file ./ema-cross-sol.json \
  --mode paper \
  --run-until-stopped \
  --detached
```

For ad-hoc indicator queries outside the strategy framework, use the top-level `vulcan ta` commands.

## Lifecycle commands

These apply to any strategy run, regardless of type. Most take the `<run-id>` returned by `start` (`runs` and `preflight` do not). List recent run IDs with `vulcan strategy runs`.

| Command | Description |
| --- | --- |
| `runs [--limit <n>]` | List persisted strategy runs. Default limit 20. |
| `status <run-id> [--since-tick <n>] [--include-ledger]` | Show latest status. `--since-tick` returns only ticks newer than the given index. |
| `monitor <run-id> [--include-ledger]` | Compact non-blocking monitor state. |
| `wait-next-tick <run-id> [--after-tick <n>] [--timeout-seconds <s>] [--include-ledger]` | Block until a new tick or terminal status is observed. Default timeout 90 seconds. |
| `report <run-id>` | Show the final (or latest) report. |
| `reconcile-grid <run-id>` | Inspect live grid orders against the persisted ledger without mutating state. |
| `pause <run-id> [--reason <r>]` | Request the runner to pause at the next safe point. |
| `stop <run-id> [--reason <r>]` | Request the runner to stop permanently at the next safe point. |
| `finalize <run-id> [--reason <r>] [--cancel-orders] [--close-position] [--wait] [--timeout-seconds <s>]` | Stop the runner and optionally cancel open orders and close the position on the strategy symbol. |
| `preflight` | Pre-launch readiness check: wallet identity, password availability, trader registration, collateral. Lists every blocker with a remedy command. |
| `resume <run-id> [--from-step <n>]` | Resume any paused or incomplete strategy run. |

### Typical operating loop

```
RUN_ID=$(vulcan strategy grid start ... --detached -o json | jq -r '.data.run_id')

vulcan strategy monitor "$RUN_ID" -o json
vulcan strategy wait-next-tick "$RUN_ID" --timeout-seconds 120

vulcan strategy pause "$RUN_ID" --reason "checking risk"
vulcan strategy resume "$RUN_ID"

vulcan strategy finalize "$RUN_ID" --cancel-orders --close-position --wait
```
