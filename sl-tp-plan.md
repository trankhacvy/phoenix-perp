# SL / TP UX Improvement Plan — ✅ COMPLETED

## Goals

1. ✅ Drop the mode-picker step — default market for SL, limit for TP
2. ✅ Show existing SL/TP in prompt header so user knows what they're replacing
3. ✅ Show entry price and unrealized P&L as context
4. ✅ Buttons show both trigger price and estimated dollar P&L from entry
5. ✅ Richer confirm screen (distance from mark, distance from entry, liq buffer)
6. ✅ Fix `clearPending` timing bug in custom price path (clears before validation)
7. ✅ Fix callback data precision (`toFixed(4)` → compact 8-decimal format)
8. ✅ Disable ladder TP button until fraction bug in `trade.ts` is fixed
9. ✅ Custom price path validates direction before clearing pending (user can retry)

---

## Files Changed

| File | Changes |
|---|---|
| `src/bot/commands/setsl.ts` | New prompt UI, remove `sendSlModePicker`, new confirm screen, export `validateSlPrice` |
| `src/bot/commands/settp.ts` | New prompt UI, remove `sendTpModePicker`, new confirm screen, export `validateTpPrice` |
| `src/bot/index.ts` | Update `editsl`/`edittp` handlers — validate inline, fix `clearPending` timing, remove mode-picker imports |

No changes to `trade.ts`, `position.ts`, callback exec handlers, or DB schema.

---

## Shared Helpers (define inside each file, not exported)

### `priceForCallback(p: number): string`

Callback data must round-trip through `Number()`. Use 8 decimal places, strip trailing zeros.

```typescript
function priceForCallback(p: number): string {
  return p.toFixed(8).replace(/\.?0+$/, "");
}
```

Examples:
- `84930` → `"84930"`
- `84930.5` → `"84930.5"`
- `0.00000123` → `"0.00000123"`

Replaces `toFixed(4)` on all %-button callback data. Regex `([\d.]+)` in existing handlers already matches.

### `estimatePnlFromEntry(pos: PhoenixPosition, triggerPrice: number): number`

Gross P&L (before fees) if position closes at `triggerPrice`.

```typescript
function estimatePnlFromEntry(pos: PhoenixPosition, triggerPrice: number): number {
  const entry = Number(pos.entryPrice);
  const size = Number(pos.size);
  if (Number.isNaN(entry) || Number.isNaN(size) || size === 0) return 0;
  return pos.side === "long"
    ? (triggerPrice - entry) * size
    : (entry - triggerPrice) * size;
}
```

Negative = net loss from entry. Positive = net gain from entry.
Always label as approximate in UI: "~-$87 (excl. fees)".

---

## 1. `src/bot/commands/setsl.ts`

### 1.1 Export `validateSlPrice`

Used by the `editsl` pending handler in `index.ts`. Returns an error string or `null` if valid.

```typescript
export function validateSlPrice(
  pos: PhoenixPosition,
  triggerPrice: number,
): string | null {
  const mark = Number(pos.markPrice);
  const liq = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);

  if (pos.side === "long") {
    if (triggerPrice >= mark) {
      return `SL for a long must be below the current price (${fmtPrice(mark)}). Enter a lower price.`;
    }
    if (liq > 0 && triggerPrice <= liq) {
      return `That price is at or below your liquidation (${fmtPrice(liq)}). Enter above ${fmtPrice(liq)}.`;
    }
  } else {
    if (triggerPrice <= mark) {
      return `SL for a short must be above the current price (${fmtPrice(mark)}). Enter a higher price.`;
    }
    if (liq > 0 && triggerPrice >= liq) {
      return `That price is at or above your liquidation (${fmtPrice(liq)}). Enter below ${fmtPrice(liq)}.`;
    }
  }
  return null;
}
```

Import `PhoenixPosition` from `../../types/index.js`.

### 1.2 Remove `sendSlModePicker` and `sendRemoveSlConfirm`

`sendSlModePicker` is no longer needed (mode picker step removed).
`sendRemoveSlConfirm` is still used from `index.ts`, keep it.

Remove from exports. Remove from `index.ts` import.

### 1.3 Rewrite `sendSlPrompt`

Key changes:
- Header shows entry, mark, existing SL, liq price
- %-buttons calculated from **mark price** (always valid), display **entry-relative P&L**
- 2×2 grid layout with one trailing button
- Button label: `-5%  $84,930  ~-$87`
- `priceForCallback` for callback data precision
- `sl_custom:` button label → "Enter price manually"
- Remove "🗑 Remove stop loss" only if `pos.stopLoss` is set (conditional row)

```typescript
export async function sendSlPrompt(
  ctx: BotContext,
  symbol: string,
  positionSide: "long" | "short",
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === positionSide);
  if (!pos) {
    await ctx.reply(`No open ${symbol} ${positionSide} position found.`);
    return;
  }

  const markPrice = Number(pos.markPrice);
  const entryPrice = Number(pos.entryPrice);
  const unrealizedPnl = Number(pos.unrealizedPnl);
  const liqPrice = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);
  const liqLabel =
    pos.liquidationPrice === "N/A" ? "Safe ✅" : fmtPrice(liqPrice);
  const currentSlLabel = pos.stopLoss ? fmtPrice(Number(pos.stopLoss)) : "—";

  const pcts = [2, 5, 10, 15, 20];
  const kb = new InlineKeyboard();

  for (let i = 0; i < pcts.length; i++) {
    const pct = pcts[i];
    // Levels from mark — always valid direction
    const triggerPrice =
      positionSide === "long" ? markPrice * (1 - pct / 100) : markPrice * (1 + pct / 100);
    const pnl = estimatePnlFromEntry(pos, triggerPrice);
    const pnlLabel = signedUsd(pnl);
    const sign = positionSide === "long" ? "-" : "+";

    kb.text(
      `${sign}${pct}%  ${fmtPrice(triggerPrice)}  ${pnlLabel}`,
      `sl:mode:${symbol}:${priceForCallback(triggerPrice)}:market:${positionSide}`,
    );
    if (i === 1 || i === 3) kb.row();
  }

  kb.row().text("Enter price manually →", `sl_custom:${symbol}:${positionSide}`);

  if (pos.stopLoss) {
    kb.row()
      .text("🗑 Clear stop loss", `sl:remove:${symbol}:${positionSide}`)
      .text("✕ Cancel", "cancel");
  } else {
    kb.row().text("✕ Cancel", "cancel");
  }

  const sideLabel = positionSide === "long" ? "LONG" : "SHORT";
  const pnlLine = fmt`${FormattedString.b(signedUsd(unrealizedPnl))} uPnL`;

  const msg = fmt`⛔ ${FormattedString.b(`Stop Loss — ${symbol} ${sideLabel}`)}\n\nEntry       ${FormattedString.b(fmtPrice(entryPrice))}\nMark now  ${FormattedString.b(fmtPrice(markPrice))}  (${pnlLine})\nLiq price   ${FormattedString.b(liqLabel)}\nCurrent SL  ${FormattedString.b(currentSlLabel)}\n\nSelect a stop loss level:`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

**Edge cases:**
- `pos.stopLoss` present → show "Clear" button; absent → no "Clear" button (nothing to remove)
- `pos.liquidationPrice === "N/A"` → show "Safe ✅", skip liq buffer in confirm
- `markPrice === 0` → `estimatePnlFromEntry` returns 0, buttons still render correctly
- `size === 0 || NaN` → `estimatePnlFromEntry` returns 0, display `$0.00` (acceptable fallback)

### 1.4 Rewrite `sendSlFinalConfirm`

Replaces the existing thin confirm screen with full context. Now takes position data (re-fetched fresh) plus proximity check.

```typescript
async function sendSlFinalConfirm(
  ctx: BotContext,
  symbol: string,
  triggerPrice: number,
  mode: "market" | "limit",
  positionSide: "long" | "short",
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === positionSide);

  if (!pos) {
    await ctx.reply(`No open ${symbol} ${positionSide} position. It may have been closed.`);
    return;
  }

  const markPrice = Number(pos.markPrice);
  const liqPrice = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);
  const pnlFromEntry = estimatePnlFromEntry(pos, triggerPrice);
  const pnlLabel = signedUsd(pnlFromEntry);

  // % distance from entry
  const entryPrice = Number(pos.entryPrice);
  const entryPct = entryPrice > 0
    ? ((triggerPrice - entryPrice) / entryPrice) * 100
    : null;
  const entryPctLabel = entryPct !== null ? pct(entryPct) : "—";

  // % distance from mark
  const markPct = markPrice > 0
    ? ((triggerPrice - markPrice) / markPrice) * 100
    : null;
  const markPctLabel = markPct !== null ? pct(markPct) : "—";

  // Liq buffer: how far trigger is from liquidation
  let liqBufferLine = fmt``;
  if (liqPrice > 0) {
    const buffer =
      positionSide === "long" ? triggerPrice - liqPrice : liqPrice - triggerPrice;
    if (buffer > 0) {
      liqBufferLine = fmt`\nLiq buffer    ${FormattedString.b(`${usd(buffer)} above liquidation`)}`;
    }
  }

  // Proximity warning if SL is very close to current mark (< 0.5%)
  const proximity =
    markPrice > 0 ? Math.abs(triggerPrice - markPrice) / markPrice : 1;
  const proximityWarn =
    proximity < 0.005
      ? fmt`\n\n⚠️ ${FormattedString.b("Warning:")} SL is very close to current price — may trigger immediately.`
      : fmt``;

  const kb = new InlineKeyboard()
    .text("✅ Set stop loss", `sl:exec:${symbol}:${priceForCallback(triggerPrice)}:${mode}:${positionSide}`)
    .text("✕ Cancel", "cancel");

  const sideLabel = positionSide === "long" ? "LONG" : "SHORT";
  const msg = fmt`⛔ ${FormattedString.b(`Stop Loss — ${symbol} ${sideLabel}`)}\n\nTrigger      ${FormattedString.b(fmtPrice(triggerPrice))}\nFrom entry   ${FormattedString.b(`${entryPctLabel}  (${pnlLabel} total)`)}${FormattedString.i("  approx, excl. fees")}\nFrom now     ${FormattedString.b(markPctLabel)}\n${liqBufferLine}${proximityWarn}\n\nIf triggered: closes position at ~${fmtPrice(triggerPrice)}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

**Edge cases:**
- `pos === undefined` after re-fetch → position closed between steps; show message, no exec button
- `liqPrice === 0` (N/A) → skip liq buffer line
- `buffer <= 0` → SL is below liq (shouldn't reach here after validation, but skip buffer line if so)
- `proximity < 0.005` → show warning
- `entryPrice === 0` → skip entry % line (show `—`)

### 1.5 Remove `sl:mode:` callback

Wait — the `sl:mode:` callback is still needed: the %-buttons in `sendSlPrompt` still emit `sl:mode:SYMBOL:PRICE:market:SIDE` and the handler calls `sendSlFinalConfirm`. Keep the handler, it already works correctly. Just make sure it uses `Number(priceStr)` for the callback data we now format with `priceForCallback`.

```typescript
// No change needed to the callback handler — regex ([\d.]+) matches both old and new formats
bot.callbackQuery(/^sl:mode:([A-Z0-9]+):([\d.]+):(market|limit):(long|short)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, priceStr, mode, side] = ctx.match.slice(1) as [string, string, "market" | "limit", "long" | "short"];
  await sendSlFinalConfirm(ctx, symbol, Number(priceStr), mode, side);
});
```

### 1.6 Update `sl_custom:` callback prompt text

```typescript
bot.callbackQuery(/^sl_custom:([A-Z0-9]+):(long|short)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];

  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);
  const markLabel = pos ? fmtPrice(Number(pos.markPrice)) : "—";
  const liqLabel =
    pos?.liquidationPrice === "N/A"
      ? "none"
      : pos?.liquidationPrice
        ? fmtPrice(Number(pos.liquidationPrice))
        : "—";
  const direction = side === "long" ? "below" : "above";

  const msg = fmt`Enter your stop loss price for ${FormattedString.b(symbol)}:\n\nCurrent: ${FormattedString.b(markLabel)}  ·  Liq: ${FormattedString.b(liqLabel)}\nMust be ${direction} current price.\n\nSend ${FormattedString.b("0")} to remove your current stop loss.`;
  await ctx.reply(msg.text, { entities: msg.entities });
  await setPending(ctx.from.id, `editsl:${symbol}:${side}`);
});
```

---

## 2. `src/bot/commands/settp.ts`

### 2.1 Export `validateTpPrice`

```typescript
export function validateTpPrice(
  pos: PhoenixPosition,
  triggerPrice: number,
): string | null {
  const mark = Number(pos.markPrice);

  if (pos.side === "long" && triggerPrice <= mark) {
    return `TP for a long must be above the current price (${fmtPrice(mark)}). Enter a higher price.`;
  }
  if (pos.side === "short" && triggerPrice >= mark) {
    return `TP for a short must be below the current price (${fmtPrice(mark)}). Enter a lower price.`;
  }
  return null;
}
```

No liq price check for TP (liq is not relevant to profit targets).

### 2.2 Remove `sendTpModePicker`

Remove implementation and export. Remove from `index.ts` import.

### 2.3 Rewrite `sendTpPrompt`

Same structure as the new `sendSlPrompt`.

```typescript
export async function sendTpPrompt(
  ctx: BotContext,
  symbol: string,
  positionSide: "long" | "short",
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === positionSide);
  if (!pos) {
    await ctx.reply(`No open ${symbol} ${positionSide} position found.`);
    return;
  }

  const markPrice = Number(pos.markPrice);
  const entryPrice = Number(pos.entryPrice);
  const unrealizedPnl = Number(pos.unrealizedPnl);
  const currentTpLabel = pos.takeProfit ? fmtPrice(Number(pos.takeProfit)) : "—";

  const pcts = [5, 10, 20, 30, 50];
  const kb = new InlineKeyboard();

  for (let i = 0; i < pcts.length; i++) {
    const pct = pcts[i];
    const triggerPrice =
      positionSide === "long" ? markPrice * (1 + pct / 100) : markPrice * (1 - pct / 100);
    const pnl = estimatePnlFromEntry(pos, triggerPrice);
    const pnlLabel = signedUsd(pnl);
    const sign = positionSide === "long" ? "+" : "-";

    kb.text(
      `${sign}${pct}%  ${fmtPrice(triggerPrice)}  ${pnlLabel}`,
      `tp:mode:${symbol}:${priceForCallback(triggerPrice)}:limit:${positionSide}`,
    );
    if (i === 1 || i === 3) kb.row();
  }

  kb.row().text("Enter price manually →", `tp_custom:${symbol}:${positionSide}`);

  // Ladder: disabled until fraction bug in trade.ts is fixed
  // kb.row().text("📊 Scale out — 3 levels (+5/+10/+20%)", `tp_ladder:${symbol}:${positionSide}`);

  if (pos.takeProfit) {
    kb.row()
      .text("🗑 Clear take profit", `tp:remove:${symbol}:${positionSide}`)
      .text("✕ Cancel", "cancel");
  } else {
    kb.row().text("✕ Cancel", "cancel");
  }

  const sideLabel = positionSide === "long" ? "LONG" : "SHORT";
  const pnlLine = fmt`${FormattedString.b(signedUsd(unrealizedPnl))} uPnL`;

  const msg = fmt`🎯 ${FormattedString.b(`Take Profit — ${symbol} ${sideLabel}`)}\n\nEntry       ${FormattedString.b(fmtPrice(entryPrice))}\nMark now  ${FormattedString.b(fmtPrice(markPrice))}  (${pnlLine})\nCurrent TP  ${FormattedString.b(currentTpLabel)}\n\nSelect a take profit level:`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

### 2.4 Rewrite `sendTpFinalConfirm`

```typescript
async function sendTpFinalConfirm(
  ctx: BotContext,
  symbol: string,
  triggerPrice: number,
  mode: "market" | "limit",
  positionSide: "long" | "short",
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === positionSide);

  if (!pos) {
    await ctx.reply(`No open ${symbol} ${positionSide} position. It may have been closed.`);
    return;
  }

  const markPrice = Number(pos.markPrice);
  const entryPrice = Number(pos.entryPrice);
  const pnlFromEntry = estimatePnlFromEntry(pos, triggerPrice);
  const pnlLabel = signedUsd(pnlFromEntry);

  const entryPct = entryPrice > 0
    ? ((triggerPrice - entryPrice) / entryPrice) * 100
    : null;
  const entryPctLabel = entryPct !== null ? pct(entryPct) : "—";

  const markPct = markPrice > 0
    ? ((triggerPrice - markPrice) / markPrice) * 100
    : null;
  const markPctLabel = markPct !== null ? pct(markPct) : "—";

  // Dynamic exec button label
  const execLabel = pnlFromEntry >= 0 ? "✅ Lock in profit" : "✅ Set take profit";

  const kb = new InlineKeyboard()
    .text(execLabel, `tp:exec:${symbol}:${priceForCallback(triggerPrice)}:${mode}:${positionSide}`)
    .text("✕ Cancel", "cancel");

  const sideLabel = positionSide === "long" ? "LONG" : "SHORT";
  const fillNote = mode === "limit"
    ? fmt`\nOrder placed at $${FormattedString.b(fmtPrice(triggerPrice))} — fills when price reaches it.`
    : fmt`\nCloses immediately when price reaches ${FormattedString.b(fmtPrice(triggerPrice))}.`;

  const msg = fmt`🎯 ${FormattedString.b(`Take Profit — ${symbol} ${sideLabel}`)}\n\nTrigger      ${FormattedString.b(fmtPrice(triggerPrice))}\nFrom entry   ${FormattedString.b(`${entryPctLabel}  (${pnlLabel} total)`)}${FormattedString.i("  approx, excl. fees")}\nFrom now     ${FormattedString.b(markPctLabel)}${fillNote}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

**Edge cases:**
- `pnlFromEntry < 0` on TP confirm: valid if position is at a loss but user still wants an exit above mark. Button says "Set take profit" not "Lock in profit" — honest labeling.
- `pos === undefined` after re-fetch → position closed between steps; show message.

### 2.5 Update `tp_custom:` callback prompt text

```typescript
bot.callbackQuery(/^tp_custom:([A-Z0-9]+):(long|short)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];

  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);
  const markLabel = pos ? fmtPrice(Number(pos.markPrice)) : "—";
  const direction = side === "long" ? "above" : "below";

  const msg = fmt`Enter your take profit price for ${FormattedString.b(symbol)}:\n\nCurrent: ${FormattedString.b(markLabel)}\nMust be ${direction} current price.\n\nSend ${FormattedString.b("0")} to remove your current take profit.`;
  await ctx.reply(msg.text, { entities: msg.entities });
  await setPending(ctx.from.id, `edittp:${symbol}:${side}`);
});
```

### 2.6 Ladder TP — disable until fix

The `TODO(ladder-fractions)` comment in `trade.ts` line 362 documents the bug: `level.fraction` is silently ignored — every ladder rung closes the entire position instead of a partial fraction. The fix requires using `buildPlacePositionConditionalOrder` from the Rise SDK (which accepts `sizePercent`), but that instruction's exact API must be confirmed.

**For now:** Comment out the ladder button in `sendTpPrompt` (done above in §2.3).

**To fix later:**
1. Confirm SDK has `buildPlacePositionConditionalOrder` with `sizePercent` or `sizeBaseLots`
2. Replace `buildPlaceStopLoss` in the `tpLevels` loop with the conditional order instruction
3. Re-enable the ladder button with updated label: `"📊 Scale out — 3 levels (+5/+10/+20%)"`
4. Confirm screen should show each level: `• +5%  $93,900  close 25%  ~+$95`

---

## 3. `src/bot/index.ts`

### 3.1 Update imports

Remove `sendSlModePicker` and `sendTpModePicker` from imports. Add `validateSlPrice` and `validateTpPrice`.

```typescript
// Before:
import { sendRemoveSlConfirm, sendSlModePicker } from "./commands/setsl.js";
import { sendRemoveTpConfirm, sendTpModePicker } from "./commands/settp.js";

// After:
import { sendRemoveSlConfirm, validateSlPrice } from "./commands/setsl.js";
import { sendRemoveTpConfirm, validateTpPrice } from "./commands/settp.js";
```

### 3.2 Rewrite `editsl` handler

Key changes:
1. `clearPending` moved to after all validation (currently clears before — user can't retry on error)
2. Inline direction/liq validation (was in `sendSlModePicker`, now done here)
3. Direct call to `sendSlFinalConfirm` — no mode picker

```typescript
if (parts[0] === "editsl") {
  const symbol = parts[1];
  const positionSide = parts[2] as "long" | "short";
  const triggerPrice = parseAmount(text);

  // Basic format validation — keep pending alive on error
  if (Number.isNaN(triggerPrice) || triggerPrice < 0) {
    await ctx.reply("Invalid price. Enter a positive number, or 0 to remove.");
    return;
  }

  if (triggerPrice === 0) {
    await clearPending(ctx.from.id);
    await sendRemoveSlConfirm(ctx, symbol, positionSide);
    return;
  }

  // Re-fetch live position for direction/liq validation
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === positionSide);

  if (!pos) {
    await clearPending(ctx.from.id);
    await ctx.reply(`No open ${symbol} ${positionSide} position. It may have been closed.`);
    return;
  }

  const validationError = validateSlPrice(pos, triggerPrice);
  if (validationError) {
    // Keep pending alive — user can type a corrected price
    await ctx.reply(validationError);
    return;
  }

  await clearPending(ctx.from.id);
  await sendSlFinalConfirm(ctx, symbol, triggerPrice, "market", positionSide);
  return;
}
```

Note: `sendSlFinalConfirm` is not currently exported from `setsl.ts`. It must be exported (change `async function` to `export async function`).

### 3.3 Rewrite `edittp` handler

```typescript
if (parts[0] === "edittp") {
  const symbol = parts[1];
  const positionSide = parts[2] as "long" | "short";
  const triggerPrice = parseAmount(text);

  if (Number.isNaN(triggerPrice) || triggerPrice < 0) {
    await ctx.reply("Invalid price. Enter a positive number, or 0 to remove.");
    return;
  }

  if (triggerPrice === 0) {
    await clearPending(ctx.from.id);
    await sendRemoveTpConfirm(ctx, symbol, positionSide);
    return;
  }

  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === positionSide);

  if (!pos) {
    await clearPending(ctx.from.id);
    await ctx.reply(`No open ${symbol} ${positionSide} position. It may have been closed.`);
    return;
  }

  const validationError = validateTpPrice(pos, triggerPrice);
  if (validationError) {
    await ctx.reply(validationError);
    return;
  }

  await clearPending(ctx.from.id);
  await sendTpFinalConfirm(ctx, symbol, triggerPrice, "limit", positionSide);
  return;
}
```

`sendTpFinalConfirm` must also be exported from `settp.ts`.

### 3.4 Add missing imports

```typescript
import { getTraderState } from "../services/phoenix/position.js";
```

Check if `getTraderState` is already imported — if not, add it.

---

## 4. Callback Data Format

### Existing callbacks that change data format

| Callback pattern | Old precision | New precision |
|---|---|---|
| `sl:mode:SYM:PRICE:MODE:SIDE` %-buttons | `toFixed(4)` | `priceForCallback` |
| `tp:mode:SYM:PRICE:MODE:SIDE` %-buttons | `toFixed(4)` | `priceForCallback` |
| `sl:exec:SYM:PRICE:MODE:SIDE` confirm | `toFixed(4)` (from old sl:mode) | `priceForCallback` |
| `tp:exec:SYM:PRICE:MODE:SIDE` confirm | `toFixed(4)` | `priceForCallback` |

All handler regexes use `([\d.]+)` — they match both formats. No regex changes needed.

### Callback data byte length budget

Telegram callback_data limit: 64 bytes. Spot-check:

```
sl:exec:WTIOIL:87500.12345678:market:short  → 43 bytes ✓
tp:exec:BTCUSDC:120000.12345678:limit:long  → 44 bytes ✓
sl:mode:GOLD:1850.12345678:market:short     → 38 bytes ✓
```

Safe margin for all realistic symbols and prices.

---

## 5. Edge Case Matrix

| Scenario | Where it hits | Handling |
|---|---|---|
| Position closed between prompt and confirm | `sendSlFinalConfirm` / `sendTpFinalConfirm` | Re-fetches; if `pos === undefined`, shows "position closed" message, no exec button |
| SL at/above mark (long) | `validateSlPrice` + `sendSlModePicker` (removed) | Caught in `validateSlPrice`; error shown, pending stays alive |
| SL at/below liq (long) | `validateSlPrice` | Caught; shows liq price, pending stays alive |
| TP at/below mark (long) | `validateTpPrice` | Caught; error shown, pending stays alive |
| User types `0` for custom SL | `index.ts` editsl handler | Calls `sendRemoveSlConfirm`, clears pending |
| User types `0` for custom TP | `index.ts` edittp handler | Calls `sendRemoveTpConfirm`, clears pending |
| Liq price is "N/A" | Prompt + confirm | Shows "Safe ✅" in prompt; skips liq buffer line in confirm |
| SL < 0.5% from mark | `sendSlFinalConfirm` | Proximity warning shown inline in confirm |
| TP at loss price (below entry for long) | `sendTpFinalConfirm` | Allowed; `pnlFromEntry < 0`; confirm button says "Set take profit" not "Lock in profit" |
| No existing SL | `sendSlPrompt` | "Current SL: —", no "Clear" button |
| Existing SL present | `sendSlPrompt` | Shows price, shows "Clear" button |
| `pos.size` is 0 or NaN | `estimatePnlFromEntry` | Returns 0; shows `$0.00` as P&L estimate |
| `pos.entryPrice` is 0 | `sendSlFinalConfirm` | `entryPct` set to `null`, shows `—` |
| `pos.markPrice` is 0 | `sendSlFinalConfirm` | `markPct` set to `null`, shows `—`; proximity check skipped (`proximity = 1`, never warns) |
| Invalid text (not a number) | `index.ts` both handlers | `parseAmount` returns NaN; error shown, pending stays alive |
| Text input after pending expired (10 min TTL) | `index.ts` | `getPending` returns null, handler skips entirely |
| Rate-limited user types price | `index.ts` | Rate limit middleware runs before text handler — if rejected, pending stays alive |
| Position has `side` mismatch | `pos.find()` | Now filters on both `symbol` AND `side` — avoids matching wrong-side position for same market |

### Critical: find by symbol AND side

Current `sendSlPrompt` finds position with:
```typescript
state.positions.find((p) => p.symbol === symbol)
```

This misses the side filter. A user could have both a long and short open on the same market (isolated subaccounts). Always filter on both:
```typescript
state.positions.find((p) => p.symbol === symbol && p.side === positionSide)
```

Apply this fix in `sendSlPrompt`, `sendTpPrompt`, `sendSlFinalConfirm`, `sendTpFinalConfirm`.

---

## 6. Number Display Rules

| Value | Format | Helper |
|---|---|---|
| Trigger price | `$84,930.00` / `$0.0025` | `fmtPrice(n)` |
| P&L from entry | `+$460.00` / `-$87.34` | `signedUsd(n)` |
| % move from entry/mark | `+5.30%` / `-2.00%` | `pct(n)` |
| Liq buffer | `$9,930.00` | `usd(n)` |
| Unrealized P&L in header | `+$123.45` | `signedUsd(n)` |
| "approx, excl. fees" note | italic suffix | `FormattedString.i(...)` |

`pct()` in `fmt.ts` already adds sign and uses 2 decimal places. Correct for all use cases.

---

## 7. Exports to Add / Remove

### `setsl.ts`
- **Add export**: `validateSlPrice`
- **Add export**: `sendSlFinalConfirm` (currently private, needed by `index.ts`)
- **Remove export**: `sendSlModePicker`

### `settp.ts`
- **Add export**: `validateTpPrice`
- **Add export**: `sendTpFinalConfirm` (currently private, needed by `index.ts`)
- **Remove export**: `sendTpModePicker`

---

## 8. Implementation Order

1. ✅ `setsl.ts` — add helpers, rewrite prompt/confirm, add exports, remove mode picker
2. ✅ `settp.ts` — same
3. ✅ `index.ts` — update imports, rewrite editsl/edittp handlers
4. ✅ Lint: `pnpm check` — 0 errors
5. ✅ TypeCheck: `tsc --noEmit` — 0 errors
6. Manual test matrix:
   - `/setsl BTC` → prompt shows entry, mark, liq, existing SL
   - Click `-5%` button → confirm shows full context
   - Click "Enter price manually" → prompt shows context, type invalid → error, pending survives, retype valid → confirm
   - Type `0` → remove confirm
   - `/settp BTC` → prompt shows entry, mark, existing TP
   - Click `+10%` → confirm, pnl positive → "Lock in profit" button
   - Position closed mid-flow → graceful "position closed" message
   - `/setsl BTC` while at a loss, click `-2%` → SL might be close to entry → liq buffer shows, no crash
