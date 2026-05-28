# UX & Copy Standards

Mandatory for every user-facing string and on-chain flow. Reviewers reject diffs that violate these.

## On-chain transaction lifecycle

Use `src/bot/lib/tx-flow.ts`. Never hand-roll loading/success/error copy.

- **Loading:** `CONFIRMING` (`"⏳ Confirming on-chain… (usually 2–5s)"`). Multi-tx flows use `"⏳ Step N/M — …"`.
- **Success:** `txSuccess({ header, body?, signature?, footer? })` → `"✅ <Header>"` + body + `"View on Solscan →"`. Always include the `$` result (realized PnL, amount) in `body` — never rely on an image alone.
- **Error:** `txError(err, action)` → `"❌ <Action> failed"` + plain reason + hint + `"↩️ Safe to retry."` (if retryable).
  - In detached IIFEs edit via `api.editMessageText(chatId, msgId, msg.text, { entities: msg.entities })`.
  - In live handlers use `renderBotError(ctx, err, { action, edit, replyMarkup })`.
- **answerCallbackQuery toast** = short present-progressive verb matching the message (`"Submitting…"`, `"Closing…"`).

## Errors

- All catches go through `toBotError` / `txError` / `renderBotError`. No bespoke `"❌ failed"` strings.
- `userMessage` = what happened; `hint` = what to do. Factual, no blame, no "!".
- Retryable errors always end with `"↩️ Safe to retry."`.

## Terminology (one name per concept — see `src/bot/lib/terms.ts`)

- **"bot wallet"** (holds USDC + SOL gas) — never "your wallet" / "Privy wallet".
- **"trading account"** (Phoenix collateral) — never "collateral balance" / "fund".
- **"margin"** = what you put in. **"position size"** = margin × leverage (avoid "notional" in user copy).
- **"liquidation price"** / **"liq price"**.

## Risk communication (perp-critical)

- The trade confirm separates "you put in `<margin>`" from "you control `<size>` (`<lev>`×)".
- Show `"Max slippage: X%"` on the trade confirm.
- Leverage ≥ 20× shows: `"⚡ High leverage — a Y% move against you triggers liquidation."`
- Risk lines state the consequence, not just "understand the risk" (e.g. "moves your liquidation price closer").
- Never weaken the existing "no stop loss → unlimited downside" warnings.
- Offer the one-tap `🛑 Stop -10%` (`tpsl:quick:sl:SYMBOL:SIDE:PCT`) wherever a position has no stop.

## Buttons

- Back = `"← Back"`. Abort = `"✕ Cancel"`. Dismiss menu = `"✕ Close"`. Confirm = `"✅ <Verb> <object>"`. Tx link = `"View on Solscan →"`.
- Emoji-prefix action buttons consistently.

## Formatting

- `@grammyjs/parse-mode` (`fmt` / `FormattedString`) only. Never `parse_mode: "HTML"` or raw HTML.
- This applies to **push alerts** too: build with `FormattedString` and pass `message: msg.text` + `entities: msg.entities` through `alertQueue` (`AlertJobData.entities`). The worker falls back to `parse_mode: "HTML"` only for not-yet-migrated callers, which must `esc()` every interpolated value.
- `link_preview_options: { is_disabled: true }` on any message with a URL (use `TX_MSG_OPTS`).

## TP / SL — the Protect flow (canonical)

TP/SL is **bracket-first and money-framed**. Most users want one stop + one target, full size — that path must be 1–2 taps. The multi-rung ladder is a power feature, kept behind an advanced door. Code: `src/bot/commands/tpsl.ts` (Protect layer); on-chain via `src/services/phoenix/conditional.ts` (unchanged).

### Entry point
- Position detail and trade-success show **one** `🛡 Protect` button → `tpsl:protect:SYMBOL:SIDE`. No separate "Set TP" / "Set SL" / quick-stop buttons.

### Presets are framed in % of MARGIN, never price %
- At leverage, price % ≠ money %. A "−5% price" stop on a 10× position is **−50% of margin**. Presets must speak money.
- Helper `marginPctToTrigger(leg, side, entry, size, margin, marginPctMag)` back-solves the trigger price from a margin-% magnitude. Never label a preset with a raw price %.

### Empty state — combined bracket plans (1 tap = both legs, full size, 1 tx)
- `PROTECT_PLANS`: `🛡 Tight −25%/+50%`, `⚖️ Balanced −50%/+100%`, `🚀 Runner −50%/+200%`.
- Plus `🛑 Stop only` / `🎯 Target only` (single-leg margin-% menus) and `⚙️ Custom / ladder` (advanced).
- A plan sets TP (limit) + SL (market) at full size in **one atomic tx** via `setPositionTpSl({ tp, sl, cancelTpIndices, cancelSlIndices })`.

### Set state
- Show each leg as `price → est PnL (±% margin)`, plus Risk:Reward (`1:X`) when both legs exist. Edit/remove per leg. `🪜 Ladder` opens the advanced chooser.

### Defaults (don't ask)
- **Size = full.** Only the ladder/custom path asks for size.
- **Mode:** SL = market (guaranteed exit), TP = limit (better fill). Auto; toggle only in the ladder.

### Ladder = advanced, opt-in
- Reachable only via `⚙️ Custom / ladder` → `tpsl:adv:*` → per-leg manager (`tpsl:open:LEG:*`). Never the default entry.

### Writes & performance
- All Protect writes go through one scaffold (`runProtectWrite`): rate-limit → idempotency → lock → `setPositionTpSl` → `invalidateCtx` → re-render Protect screen → `txError` on failure.
- `loadPositionCtx` is cached ~4s and **must be invalidated after every write** (`invalidateCtx`) so post-write renders show truth. One setup ≈ 2–3 Phoenix calls, not 10–16.

### Known edge
- Presets are measured from **entry** (correct money semantics). On a position already deep in profit, a target can land below current mark; Phoenix rejects it and it surfaces as a clean `txError`. Direct users to Custom in that case. Per-asset volatility clamping on too-tight stops is a future improvement.

## Tone

Calm, precise, second-person. Numbers lead; prose supports. No hype.
