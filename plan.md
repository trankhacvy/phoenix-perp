# Trade Flow — UX Redesign & Bug Fix Plan

## Overview

Two goals:
1. **New UI flow** — size-first ordering, plain-English wording, trader-friendly numbers
2. **Bug fixes** — activation gate, rate-limit gap, anchor precision, decimal leverage, price-drift restart

The `confirm:side:SYMBOL:LEV:AMT:ANCHOR` callback and the execution path (`placeMarketOrder`) are **unchanged**. Only the steps leading up to confirm change.

---

## 1. New Flow Design

### Before (leverage → size)
```
/long BTC
  → sendLeveragePicker        ← user picks 10x with no context
    → sendSizePicker          ← shows "10% = $50" (just margin, not position)
      → sendTradeConfirm      ← user finally sees what they're actually opening
        → confirm:long:BTC:10:50:87000
```

### After (size → leverage)
```
/long BTC
  [activation + balance gate here]
  → sendSizeStep              ← "You have $500. How much to risk?"
    → sendLevStep             ← "Risking $125. At what multiple? 5x = $625 · 10x = $1,250"
      → sendTradeConfirm      ← redesigned: plain English, position size prominent
        → confirm:long:BTC:10:125:87000
```

### Callback chain (new names)

| Step | Old callback | New callback | Notes |
|------|-------------|--------------|-------|
| Entry from button | `trade:long:BTC` | `trade:long:BTC` | unchanged |
| Size selected | `trade_lev:long:BTC:10` | `trade_size:long:BTC:125.00` | LEV→AMT |
| Custom size prompt | `trade_lev_custom:long:BTC` | `trade_size_custom:long:BTC` | no LEV |
| Leverage selected | `trade_size:long:BTC:10:125.00` | `trade_lev:long:BTC:125.00:10` | AMT before LEV |
| Custom lev prompt | `trade_size_custom:long:BTC:10` | `trade_lev_custom:long:BTC:125.00` | AMT replaces LEV |
| Execute | `confirm:long:BTC:10:125.00:...` | `confirm:long:BTC:10:125.00:...` | **unchanged** |

### Pending state keys (bot/index.ts)

| Old key | New key |
|---------|---------|
| `trade_leverage:long:BTC` | `trade_size_input:long:BTC` |
| `trade_size:long:BTC:10` | `trade_lev_input:long:BTC:125.00` |

---

## 2. New Screen Designs

### Screen A — Symbol picker (minor change: add price)

```
🟢 Long — pick a market

[BTC $87,000]  [ETH $3,400]  [SOL $145]
[BNB $580]  [AVAX $36]
[Browse all markets →]
```

Prices fetched via `Promise.allSettled` over `getMarketSnapshot` for the 5 symbols.
Fall back to symbol-only label if snapshot fails.

---

### Screen B — Size step (NEW, replaces leverage picker as step 1)

```
🟢 Long BTC · $87,000

Your balance: $500.00

How much do you want to risk?

[$50  (10%)]
[$125  (25%)]
[$250  (50%)]
[$500  (100%)]
[Enter custom amount]
[← Back]  [✕ Cancel]
```

Key changes from old leverage picker:
- Balance shown prominently so buttons have meaning
- Buttons show dollar amount first, percentage second (opposite of old)
- No leverage shown here at all
- Activation gate and zero-balance gate happen **before** this screen

---

### Screen C — Leverage step (NEW, replaces size picker as step 2)

```
🟢 Long BTC · Risking $125

Pick your multiplier:

[2x · $250]
[5x · $625]
[10x · $1,250]  ← default (★)
[20x · $2,500]  ← max for BTC
[Enter custom leverage]
[← Back]  [✕ Cancel]
```

Key changes:
- "You control $X" shown for each leverage button — user sees the actual position size
- Max leverage label shows the market cap explicitly
- Default leverage (from user settings) marked with ★
- Buttons filtered to ≤ maxLeverage (same as before)
- "← Back" goes to size step (preserves symbol)

---

### Screen D — Confirm (redesigned wording)

```
📋 Open Long BTC

You risk:     $125.00
You control:  $1,250.00 of BTC  (10×)
Entry near:   ~$87,000

Fee:          $0.44  (0.035%)
You pay:      $125.44

Stop-out if BTC falls 9% to ~$78,300 ⚠️

Daily holding cost: $0.41
(Price as of now — quote expires in ~30s)

[✅ Long $1,250 of BTC]        [✕ Cancel]
```

Key changes:
- "You risk / You control" instead of "Your margin / Position value"
- Leverage shown inline after "You control"
- Fee shown as `$X (Y%)` — percentage makes it legible
- "You pay" = margin + fee (not called "total cost")
- Liq line: distance percentage first, price second
- "Daily holding cost" instead of "Funding 12% APR"
- Confirm button says what it does: "Long $1,250 of BTC"
- Funding shown as income if rate is negative: "Daily income: $0.41 (rate in your favour)"

---

### Screen E — Success (redesigned)

```
✅ Opened — Long $1,250 of BTC

Entry: ~$87,000
Fee paid: $0.44

⚠️ No stop loss set. A 10% drop closes you at ~$78,300.

[🛑 Set stop loss]
[📊 View position]
[Solscan ↗]
```

Key changes:
- Position size ($1,250) is the hero number, not "Trade opened!"
- Stop-loss nudge with concrete price shown
- Solscan demoted to tertiary action (small text link)

---

### Price-drift recovery (new inline refresh)

Old behavior on `PRICE_DRIFT` error: "Re-open the trade." (sends user back to symbol picker, loses all state)

New behavior: show "Refresh price" button that re-renders the confirm screen with the new price, same symbol/leverage/size:

```
⚠️ Price moved (BTC: $87,000 → $87,450 · +0.5%)
Your quote expired.

[🔄 Refresh price]  [✕ Cancel]
```

Callback: `trade_refresh:long:BTC:10:125.00` → calls `sendTradeConfirm(ctx, side, symbol, lev, size)` directly with `edit: true`.

---

## 3. File Changes

### 3.1 `src/bot/lib/fmt.ts` — new helpers

Add these two formatters (no existing code changes):

```typescript
// "Daily holding cost: $0.41" or "Daily income: $0.41"
export function fundingDailyUsd(rateDecimal: number, notionalUsdc: number): string {
  // 3 funding events per day
  const dailyUsd = Math.abs(rateDecimal) * notionalUsdc * 3;
  return `$${num(dailyUsd, 2, 2)}/day`;
}

// "falls 9% to ~$78,300" or "rises 9% to ~$95,700"
export function liqDistanceLabel(
  side: "long" | "short",
  markPrice: number,
  liqPrice: number,
): string {
  const dist =
    side === "long"
      ? ((markPrice - liqPrice) / markPrice) * 100
      : ((liqPrice - markPrice) / markPrice) * 100;
  const dir = side === "long" ? "falls" : "rises";
  return `${dir} ${num(dist, 0, 1)}% to ~${price(liqPrice)}`;
}
```

---

### 3.2 `src/bot/keyboards/trade.ts` — redesign both keyboards

Full replacement:

```typescript
import { InlineKeyboard } from "grammy";
import { price as fmtPrice, usd } from "../lib/fmt.js";

/**
 * Step 1 keyboard — size selection.
 * Buttons show dollar amount (primary) and percentage (secondary).
 */
export function sizePickerKeyboard(
  side: "long" | "short",
  symbol: string,
  availableMargin: number,
): InlineKeyboard {
  const pcts = [10, 25, 50, 100];
  const kb = new InlineKeyboard();
  for (const p of pcts) {
    const amt = parseFloat(((availableMargin * p) / 100).toFixed(2));
    kb.text(`${usd(amt)}  (${p}%)`, `trade_size:${side}:${symbol}:${amt}`).row();
  }
  kb.text("Enter custom amount", `trade_size_custom:${side}:${symbol}`)
    .row()
    .text("← Back", `trade:${side}:${symbol}`)   // back to symbol picker
    .text("✕ Cancel", "cancel");
  return kb;
}

/**
 * Step 2 keyboard — leverage selection.
 * Each button shows position size the user will control.
 * @param sizeUsdc   margin amount chosen in step 1
 * @param markPrice  current mark price (for display only)
 */
export function leveragePickerKeyboard(
  side: "long" | "short",
  symbol: string,
  sizeUsdc: number,
  markPrice: number,
  maxLeverage: number,
  defaultLeverage: number,
): InlineKeyboard {
  const options = [2, 3, 5, 10, 20, 50].filter((l) => l <= maxLeverage);
  const kb = new InlineKeyboard();
  let count = 0;
  for (const l of options) {
    const positionSize = sizeUsdc * l;
    const star = l === defaultLeverage ? "★ " : "";
    kb.text(`${star}${l}× · ${usd(positionSize, 0, 0)}`, `trade_lev:${side}:${symbol}:${sizeUsdc}:${l}`);
    count++;
    if (count % 2 === 0) kb.row();
  }
  kb.row()
    .text("Enter custom", `trade_lev_custom:${side}:${symbol}:${sizeUsdc}`)
    .row()
    .text("← Back", `trade:${side}:${symbol}`)   // back to symbol picker (size re-selected)
    .text("✕ Cancel", "cancel");
  return kb;
}

export function confirmKeyboard(action: string): InlineKeyboard {
  return new InlineKeyboard().text("✅ Confirm", `confirm:${action}`).text("✕ Cancel", "cancel");
}
```

> **Note:** `← Back` on the leverage picker goes back to symbol picker (not size picker), because
> size is encoded in the callback and the user can just re-select symbol → size. If we want true
> back-to-size-picker, we'd need a `trade_back_to_size:side:SYMBOL:AMT` callback. That's optional
> polish; for now, back-to-symbol is fine.

---

### 3.3 `src/bot/middleware/rate-limit.ts` — extract helper

Add `checkOrderRateLimit` without changing the existing exports:

```typescript
const ORDER_LIMIT = 5;
const WINDOW_SECONDS = 60;

// Exported helper — use inside confirm callbacks where middleware can't be composed
export async function checkOrderRateLimit(ctx: BotContext): Promise<boolean> {
  if (!ctx.from) return true;
  const key = `ratelimit:orders:${ctx.from.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SECONDS);
  if (count > ORDER_LIMIT) {
    ctx.actionLog = { outcome: "error", errorCode: "RATE_LIMIT", errorCategory: "ratelimit" };
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery("Too many orders. Wait a minute.");
    } else {
      await ctx.reply("Too many orders. Wait a minute.");
    }
    return false;
  }
  return true;
}
```

---

### 3.4 `src/bot/commands/long.ts` — full rewrite

This is the core change. Annotated section by section.

#### Command entry (`/long`)

```typescript
bot.command("long", async (ctx) => {
  if (!ctx.user) {
    await ctx.reply("Type /start first.");
    return;
  }

  // ── Activation gate (new) ─────────────────────────────────────────────────
  if (!ctx.user.phoenixActivated) {
    const kb = new InlineKeyboard().text("Activate account", "nav:activate");
    await ctx.reply(
      "Your trading account isn't activated yet.\nUse /activate <code> to unlock trading.",
      { reply_markup: kb },
    );
    return;
  }

  const parts = ctx.match?.trim().split(/\s+/) ?? [];
  const symbol = parts[0]?.toUpperCase().replace("/USD", "").replace("/USDT", "");

  if (!symbol) {
    await sendSymbolPicker(ctx, "long");
    return;
  }

  // ── One-liner: /long BTC 10x 500 ─────────────────────────────────────────
  if (parts.length >= 3) {
    const lev = parseLeverage(parts[1]);  // parseLeverage handles "2.5x" → 2.5
    const size = parseAmount(parts[2]);
    if (Number.isNaN(lev) || lev < 1 || !Number.isFinite(lev)) {
      await ctx.reply(
        "Invalid leverage — use a number like 10 or 2.5x (minimum 1).\nExample: /long BTC 10x 500",
      );
      return;
    }
    if (Number.isNaN(size) || size <= 0) {
      await ctx.reply(
        "Invalid amount.\nExample: /long BTC 10x 500",
      );
      return;
    }
    await sendTradeConfirm(ctx, "long", symbol, lev, size);
    return;
  }

  // ── Guided flow: /long BTC ────────────────────────────────────────────────
  await sendSizeStep(ctx, "long", symbol);
});
```

**What changed:** activation gate added; one-liner validation message improved; entry now calls `sendSizeStep` instead of `sendLeveragePicker`.

---

#### `sendSymbolPicker` — add prices

```typescript
export async function sendSymbolPicker(ctx: BotContext, side: "long" | "short"): Promise<void> {
  const popular = ["BTC", "ETH", "SOL", "BNB", "AVAX"];
  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";

  // Fetch prices in parallel; fall back gracefully
  const snaps = await Promise.allSettled(popular.map((s) => getMarketSnapshot(s)));

  const kb = new InlineKeyboard();
  popular.forEach((s, i) => {
    const snap = snaps[i].status === "fulfilled" ? snaps[i].value : null;
    const priceStr = snap ? ` ${fmtPrice(snap.markPrice)}` : "";
    kb.text(`${s}${priceStr}`, `trade:${side}:${s}`);
  });
  kb.row().text("Browse all markets →", "markets:page:0");

  const msg = fmt`${emoji} ${FormattedString.b(label)} — pick a market:`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

---

#### `sendSizeStep` — NEW (was `sendLeveragePicker`, now step 1)

```typescript
export async function sendSizeStep(
  ctx: BotContext,
  side: "long" | "short",
  symbol: string,
): Promise<void> {
  if (!ctx.user) return;

  // Isolated-only gate
  if (isIsolatedOnly(symbol)) {
    const msg = fmt`⚠️ ${FormattedString.b(symbol)} needs an isolated margin account — not available yet.\n\nUse /markets to find other markets.`;
    await ctx.reply(msg.text, { entities: msg.entities });
    return;
  }

  // Market exists gate
  let snapshot: Awaited<ReturnType<typeof getMarketSnapshot>>;
  try {
    snapshot = await getMarketSnapshot(symbol);
  } catch {
    await ctx.reply(`Market "${symbol}" not found. Use /markets to browse.`);
    return;
  }

  // Balance gate
  const state = await getTraderState(ctx.user.walletAddress);
  const available = Number(state.effectiveCollateral);
  if (available <= 0) {
    const kb = new InlineKeyboard().text("📥 Deposit USDC", "nav:deposit");
    const msg = fmt`You have no funds to trade with.\n\nDeposit USDC to get started.`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
    return;
  }

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";
  const kb = sizePickerKeyboard(side, symbol, available);

  const msg = fmt`${emoji} ${FormattedString.b(`${label} ${symbol}`)}  ·  ${fmtPrice(snapshot.markPrice)}\n\nYour balance: ${FormattedString.b(usd(available))}\n\nHow much do you want to risk?`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

---

#### `sendLevStep` — NEW (was `sendSizePicker`, now step 2)

```typescript
export async function sendLevStep(
  ctx: BotContext,
  side: "long" | "short",
  symbol: string,
  sizeUsdc: number,
): Promise<void> {
  if (!ctx.user) return;

  let snapshot: Awaited<ReturnType<typeof getMarketSnapshot>>;
  try {
    snapshot = await getMarketSnapshot(symbol);
  } catch {
    await ctx.reply(`Market "${symbol}" not found. Use /markets to browse.`);
    return;
  }

  const settings = (await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, ctx.user.id),
  })) ?? { defaultLeverage: 5 };

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";

  // Funding line: show as daily cost/income, only if meaningful
  let fundingNote = fmt``;
  const dailyUsd = Math.abs(snapshot.fundingRate) * sizeUsdc * snapshot.maxLeverage * 3;
  // Only show funding if > $0.05/day on a max-leverage position
  if (dailyUsd > 0.05) {
    const isLongPayingFunding = snapshot.fundingRate > 0;
    const youPay = side === "long" ? isLongPayingFunding : !isLongPayingFunding;
    const verb = youPay ? "costs you" : "earns you";
    // Use estimate at defaultLeverage for display
    const dailyAtDefault = fundingDailyUsd(snapshot.fundingRate, sizeUsdc * settings.defaultLeverage);
    fundingNote = fmt`\n💸 Funding ${verb} ≈${FormattedString.b(dailyAtDefault)} at ${settings.defaultLeverage}× (varies by leverage)\n`;
  }

  const kb = leveragePickerKeyboard(
    side,
    symbol,
    sizeUsdc,
    snapshot.markPrice,
    snapshot.maxLeverage,
    settings.defaultLeverage,
  );

  const msg = fmt`${emoji} ${FormattedString.b(`${label} ${symbol}`)}  ·  risking ${FormattedString.b(usd(sizeUsdc))}\n${fundingNote}\nPick your multiplier — buttons show position size you'd control:`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
```

---

#### `sendTradeConfirm` — redesigned wording

```typescript
export async function sendTradeConfirm(
  ctx: BotContext,
  side: "long" | "short",
  symbol: string,
  lev: number,
  sizeUsdc: number,
  edit = false,
): Promise<void> {
  if (!ctx.user) return;

  let pf: PreflightResult;
  try {
    pf = await preflightOpen({
      user: ctx.user,
      symbol,
      side,
      marginUsdc: sizeUsdc,
      leverage: lev,
    });
  } catch (e) {
    await renderBotError(ctx, e, { action: "Open trade" });
    return;
  }

  const { snapshot, effectiveLeverage, notional, feeUsdc, liqPrice, totalCost } = pf;
  const entry = snapshot.markPrice;
  const feePct = ((feeUsdc / notional) * 100).toFixed(3);

  // Liq distance in plain English
  const liqLine = liqDistanceLabel(side, entry, liqPrice);

  // Funding as daily cost/income — only show if meaningful
  const dailyCost = Math.abs(snapshot.fundingRate) * notional * 3;
  const isLongPayingFunding = snapshot.fundingRate > 0;
  const youPay = side === "long" ? isLongPayingFunding : !isLongPayingFunding;
  let fundingLine = fmt``;
  if (dailyCost > 0.01) {
    if (youPay) {
      fundingLine = fmt`\n💸 Daily holding cost:  ${FormattedString.b(`$${dailyCost.toFixed(2)}/day`)}`;
    } else {
      fundingLine = fmt`\n💰 Daily funding income:  ${FormattedString.b(`$${dailyCost.toFixed(2)}/day`)} (rate in your favour)`;
    }
  }

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";
  const stopWord = side === "long" ? "falls" : "rises";

  // Anchor price stored with enough precision — use String() to avoid toFixed(8) truncation
  const anchorStr = entry.toPrecision(12);

  const kb = new InlineKeyboard()
    .text(
      `✅ ${label} ${usd(notional, 0, 0)} of ${symbol}`,
      `confirm:${side}:${symbol}:${effectiveLeverage}:${sizeUsdc}:${anchorStr}`,
    )
    .row()
    .text("✕ Cancel", "cancel");

  const msg = fmt`📋 ${FormattedString.b("Open trade")}\n\n${emoji} ${FormattedString.b(`${label} ${symbol}`)}  (${effectiveLeverage}×)\n\nYou risk:       ${FormattedString.b(usd(sizeUsdc))}\nYou control:    ${FormattedString.b(usd(notional))} of ${symbol}\nEntry near:     ${FormattedString.b(`~${fmtPrice(entry)}`)}\n\nFee:            ${FormattedString.b(`${usd(feeUsdc)} (${feePct}%)`)}\nYou pay:        ${FormattedString.b(usd(totalCost))}\n\nStop-out if price ${stopWord} ${liqLine}${fundingLine}\n\n${FormattedString.i("(Quote based on current price)")}`
  ;

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}
```

---

#### Callback handlers

Replace the five callback handlers in `registerLong`. Key changes in each:

**`trade:long:SYMBOL`** (entry from button — now calls `sendSizeStep`):
```typescript
bot.callbackQuery(/^trade:long:([A-Z0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  // Activation gate
  if (!ctx.user.phoenixActivated) {
    await ctx.reply("Activate your account first. Use /activate <code>.");
    return;
  }
  await sendSizeStep(ctx, "long", ctx.match[1]);
});
```

**`trade_size:long:SYMBOL:AMT`** (size chosen — now calls `sendLevStep`):
```typescript
bot.callbackQuery(/^trade_size:long:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  await sendLevStep(ctx, "long", ctx.match[1], Number(ctx.match[2]));
});
```

**`trade_size_custom:long:SYMBOL`** (custom size — prompt text input):
```typescript
bot.callbackQuery(/^trade_size_custom:long:([A-Z0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const symbol = ctx.match[1];
  const state = await getTraderState(ctx.user.walletAddress);
  const available = Number(state.effectiveCollateral);
  const msg = fmt`Enter the amount you want to risk (USD):\n(Your balance: ${FormattedString.code(usd(available))})`;
  await ctx.reply(msg.text, { entities: msg.entities });
  await setPending(ctx.from.id, `trade_size_input:long:${symbol}`);
});
```

**`trade_lev:long:SYMBOL:AMT:LEV`** (leverage chosen — calls `sendTradeConfirm`):
```typescript
bot.callbackQuery(/^trade_lev:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, amtStr, levStr] = ctx.match.slice(1);
  await sendTradeConfirm(ctx, "long", symbol, Number(levStr), Number(amtStr));
});
```

**`trade_lev_custom:long:SYMBOL:AMT`** (custom leverage — prompt text input):
```typescript
bot.callbackQuery(/^trade_lev_custom:long:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, amtStr] = ctx.match.slice(1);
  const snap = await getMarketSnapshot(symbol).catch(() => null);
  const maxLev = snap?.maxLeverage ?? 100;
  await ctx.reply(`Enter your leverage for ${symbol} (1–${maxLev}×):`);
  await setPending(ctx.from.id, `trade_lev_input:long:${symbol}:${amtStr}`);
});
```

**`confirm:long:SYMBOL:LEV:AMT:ANCHOR`** (execute — add rate-limit check, unchanged logic):
```typescript
bot.callbackQuery(/^confirm:long:([A-Z0-9]+):([\d.]+):([\d.]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Opening…");
  if (!ctx.user) return;

  // Rate limit check (bug fix — was missing here)
  if (!await checkOrderRateLimit(ctx)) return;

  const [symbol, leverageStr, sizeStr, anchorStr] = ctx.match.slice(1);
  const lev = Number(leverageStr);
  const sizeUsdc = Number(sizeStr);
  const anchorPrice = Number(anchorStr);

  let pf: PreflightResult;
  try {
    pf = await preflightOpen({ user: ctx.user, symbol, side: "long", marginUsdc: sizeUsdc, leverage: lev, anchorPrice });
  } catch (e) {
    const be = toBotError(e);
    ctx.actionLog = { outcome: "error", errorCode: be.code, errorCategory: be.category };

    // Price drift: show inline refresh instead of full restart
    if (be.code === "PRICE_DRIFT") {
      const kb = new InlineKeyboard()
        .text("🔄 Refresh price", `trade_refresh:long:${symbol}:${lev}:${sizeUsdc}`)
        .text("✕ Cancel", "cancel");
      await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
      return;
    }

    const kb = new InlineKeyboard()
      .text("Try again", `trade:long:${symbol}`)
      .text("← Back", "nav:positions");
    await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
    return;
  }

  try {
    const baseUnits = marginToTokens(pf.snapshot, sizeUsdc, pf.effectiveLeverage, anchorPrice > 0 ? anchorPrice : undefined);
    const sig = await trackAction(
      { userId: ctx.user.id, command: "trade.long", args: { symbol, leverage: pf.effectiveLeverage, marginUsdc: sizeUsdc, notional: pf.notional } },
      () => placeMarketOrder({ symbol, side: "long", baseUnits, walletAddress: ctx.user!.walletAddress }),
    );
    ctx.actionLog = { skip: true };
    await subscribeUser(ctx.user.walletAddress, ctx.user.telegramId);

    // Success screen — SL nudge
    const liqHint = liqDistanceLabel("long", pf.snapshot.markPrice, pf.liqPrice);
    const kb = new InlineKeyboard()
      .text("🛑 Set stop loss", `editsl:${symbol}:long`)
      .row()
      .text("📊 View position", "nav:positions");

    const msg = fmt`✅ ${FormattedString.b(`Opened — Long ${usd(pf.notional, 0, 0)} of ${symbol}`)}\n\nEntry: ~${fmtPrice(pf.snapshot.markPrice)}\nFee paid: ${usd(pf.feeUsdc)}\n\n⚠️ No stop loss set. If price ${liqHint} you get stopped out.\n\n${FormattedString.link("Solscan ↗", solscanUrl(sig))}`;
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb, link_preview_options: { is_disabled: true } });
  } catch (e) {
    logger.error({ err: e, symbol, side: "long" }, "placeMarketOrder failed");
    ctx.actionLog = { skip: true };
    const kb = new InlineKeyboard().text("Try again", `trade:long:${symbol}`).text("← Back", "nav:positions");
    await renderBotError(ctx, e, { action: "Trade", edit: true, replyMarkup: kb });
  }
});
```

**`trade_refresh:long:SYMBOL:LEV:AMT`** (new — price-drift inline refresh):
```typescript
bot.callbackQuery(/^trade_refresh:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Refreshing price…");
  if (!ctx.user) return;
  const [symbol, levStr, amtStr] = ctx.match.slice(1);
  // Re-render confirm screen in place with fresh price (edit: true)
  await sendTradeConfirm(ctx, "long", symbol, Number(levStr), Number(amtStr), true);
});
```

---

### 3.5 `src/bot/commands/short.ts` — update delegated calls

`short.ts` imports and delegates to `long.ts` shared functions. Three changes:

1. Replace `sendLeveragePicker` import with `sendSizeStep`
2. Update the `trade:short:SYMBOL` callback to call `sendSizeStep`
3. Update `trade_lev:short:...`, `trade_size:short:...` callbacks to match new signatures

The function names change but the pattern is identical to long.ts — use the same approach.

```typescript
// Change import at top:
import { sendSizeStep, sendLevStep, sendSymbolPicker, sendTradeConfirm } from "./long.js";

// Change the bot.command("short") entry:
await sendSizeStep(ctx, "short", symbol);   // was sendLeveragePicker

// New callback for trade:short:SYMBOL:
await sendSizeStep(ctx, "short", ctx.match[1]);  // was sendLeveragePicker

// New callback trade_size:short:SYMBOL:AMT:
bot.callbackQuery(/^trade_size:short:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  await sendLevStep(ctx, "short", ctx.match[1], Number(ctx.match[2]));
});

// New callback trade_lev:short:SYMBOL:AMT:LEV:
bot.callbackQuery(/^trade_lev:short:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, amtStr, levStr] = ctx.match.slice(1);
  await sendTradeConfirm(ctx, "short", symbol, Number(levStr), Number(amtStr));
});
```

The `confirm:short:...` handler in short.ts also gets the same two fixes as long.ts:
- `checkOrderRateLimit(ctx)` at the top
- `trade_refresh:short:SYMBOL:LEV:AMT` callback for price-drift recovery

---

### 3.6 `src/bot/index.ts` — update pending state dispatch

Two pending keys change. Find the `bot.on("message:text")` handler and update:

```typescript
// OLD:
if (parts[0] === "trade_leverage") {
  const side = parts[1] as "long" | "short";
  const symbol = parts[2];
  const lev = parseLeverage(text);
  if (Number.isNaN(lev) || lev < 1) {
    await ctx.reply("Invalid leverage. Enter a number like 10 or 10x.");
    return;
  }
  await sendSizePicker(ctx, side, symbol, lev);
  return;
}

if (parts[0] === "trade_size") {
  const side = parts[1] as "long" | "short";
  const symbol = parts[2];
  const lev = Number(parts[3]);
  const size = parseAmount(text);
  if (Number.isNaN(size) || size <= 0) {
    await ctx.reply("Invalid amount. Enter a USD value like 500.");
    return;
  }
  await sendTradeConfirm(ctx, side, symbol, lev, size);
  return;
}
```

```typescript
// NEW:
if (parts[0] === "trade_size_input") {
  const side = parts[1] as "long" | "short";
  const symbol = parts[2];
  const size = parseAmount(text);
  if (Number.isNaN(size) || size <= 0) {
    await ctx.reply("Invalid amount. Enter a USD value like 100.");
    return;
  }
  await sendLevStep(ctx, side, symbol, size);
  return;
}

if (parts[0] === "trade_lev_input") {
  const side = parts[1] as "long" | "short";
  const symbol = parts[2];
  const amt = Number(parts[3]);
  const lev = parseLeverage(text);
  if (Number.isNaN(lev) || lev < 1 || !Number.isFinite(lev)) {
    await ctx.reply("Invalid leverage. Enter a number like 10 or 2.5 (minimum 1).");
    return;
  }
  await sendTradeConfirm(ctx, side, symbol, lev, amt);
  return;
}
```

Also add the two new imports at top of file:
```typescript
import { sendLevStep, sendSizeStep, sendTradeConfirm } from "./commands/long.js";
// remove: sendSizePicker (no longer exported under that name)
```

---

## 4. Bug Fixes (isolated)

### Bug A — Rate limit not applied to confirm callbacks

**Files:** `src/bot/commands/long.ts`, `src/bot/commands/short.ts`  
**Fix:** Already incorporated above — `checkOrderRateLimit(ctx)` at the top of both `confirm:long` and `confirm:short` handlers.

```typescript
// Top of confirm:long handler, before any logic:
if (!await checkOrderRateLimit(ctx)) return;
```

---

### Bug B — Activation check only at preflight (too late)

**Files:** `src/bot/commands/long.ts`, `src/bot/commands/short.ts`  
**Fix:** Already incorporated above — check at command entry AND at `trade:side:SYMBOL` callback.

```typescript
// In bot.command("long"):
if (!ctx.user.phoenixActivated) {
  const kb = new InlineKeyboard().text("Activate account", "nav:activate");
  await ctx.reply("Your trading account isn't activated yet.\nUse /activate <code>.", { reply_markup: kb });
  return;
}

// In trade:long:SYMBOL callback:
if (!ctx.user.phoenixActivated) {
  await ctx.reply("Activate your account first. Use /activate <code>.");
  return;
}
```

---

### Bug C — Anchor price precision (`toFixed(8)`)

**File:** `src/bot/commands/long.ts`, `sendTradeConfirm`  
**Current:**
```typescript
`confirm:${side}:${symbol}:${effectiveLeverage}:${sizeUsdc}:${entry.toFixed(8)}`
```
**Fix:**
```typescript
`confirm:${side}:${symbol}:${effectiveLeverage}:${sizeUsdc}:${entry.toPrecision(12)}`
```

`toPrecision(12)` gives 12 significant figures regardless of magnitude. For BTC at $87,000.123456789, this gives `87000.1234568` (enough). For a micro-cap at $0.00000123456789, it gives `0.00000123456789000` (12 significant figures). No precision loss within the slippage check threshold.

---

### Bug D — Decimal leverage rejected in one-liner

**File:** `src/bot/commands/long.ts` and `short.ts`  
**Current validation:**
```typescript
if (Number.isNaN(lev) || lev < 1 || Number.isNaN(size) || size <= 0) {
```
**Issue:** The check `lev < 1` is correct, but the error message only shows integer examples (`10x`). Additionally `!Number.isFinite(lev)` should also be checked to guard against `Infinity`.

**Fix:**
```typescript
if (Number.isNaN(lev) || lev < 1 || !Number.isFinite(lev) || Number.isNaN(size) || size <= 0) {
  await ctx.reply(
    "Invalid format. Example: /long BTC 10x 500 or /long BTC 2.5x 100\nOr just type /long BTC for the guided flow.",
  );
  return;
}
```

---

### Bug E — Price drift sends user back to symbol picker (loses state)

**File:** `src/bot/commands/long.ts`, `confirm:long` handler  
**Fix:** Already incorporated above — `trade_refresh` callback re-renders confirm screen in-place.

```typescript
// In confirm handler's catch block, before generic error:
if (be.code === "PRICE_DRIFT") {
  const kb = new InlineKeyboard()
    .text("🔄 Refresh price", `trade_refresh:long:${symbol}:${lev}:${sizeUsdc}`)
    .text("✕ Cancel", "cancel");
  await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
  return;
}
```

```typescript
// New callback (in registerLong):
bot.callbackQuery(/^trade_refresh:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Refreshing…");
  if (!ctx.user) return;
  const [symbol, levStr, amtStr] = ctx.match.slice(1);
  await sendTradeConfirm(ctx, "long", symbol, Number(levStr), Number(amtStr), true);
});
```

Same pattern for `short`.

---

### Bug F — `dispatchInstructions` sends each TP/SL instruction as separate tx

**File:** `src/services/phoenix/trade.ts`, `dispatchInstructions` function  
**Scope:** TP/SL only (`setTpSl`). Does not affect the long/short flow.

**Current:**
```typescript
async function dispatchInstructions(ixs: AnyInstruction[], walletAddress: string): Promise<string> {
  let sig = "";
  for (const ix of ixs) {
    sig = await dispatchInstruction(ix, walletAddress);
  }
  return sig;
}
```

**Fix:** Batch all instructions into one transaction:
```typescript
async function dispatchInstructions(ixs: AnyInstruction[], walletAddress: string): Promise<string> {
  if (ixs.length === 0) throw new Error("No instructions to dispatch");
  if (ixs.length === 1) return dispatchInstruction(ixs[0], walletAddress);

  // Batch: one blockhash, one tip, one confirmation poll
  const signer = await getSigner(walletAddress);
  const latestBlockhash = await getBlockhash();
  const tipAccount = JITO_TIP_ACCOUNTS[
    Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)
  ] as Address;

  const signedIxs = ixs.map((ix) => addSignersToInstruction([signer], ix));

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitPriceInstruction({ microLamports: COMPUTE_UNIT_PRICE }),
          getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
          ...signedIxs,
          getTransferSolInstruction({ source: signer, destination: tipAccount, amount: lamports(JITO_TIP_LAMPORTS) }),
        ],
        tx,
      ),
  );

  const signedTx = await signTransactionMessageWithSigners(message);
  const txBytes = getTransactionEncoder().encode(signedTx);
  const sig = await sendViaHeliusSender(Buffer.from(txBytes).toString("base64"));
  await pollConfirmation(sig);
  return sig;
}
```

**Note:** Verify the Rise SDK instruction accounts are compatible in a single tx before enabling this. If they require separate accounts setup, keep sequential dispatch but file a note.

---

## 5. Implementation Order

Do these in sequence — each step is independently testable:

1. **`fmt.ts`** — add `fundingDailyUsd` + `liqDistanceLabel` (no deps, testable immediately)
2. **`rate-limit.ts`** — add `checkOrderRateLimit` export
3. **`keyboards/trade.ts`** — new keyboards (can test with mock data)
4. **`long.ts`** — full rewrite (biggest change)
5. **`short.ts`** — update to match long.ts changes
6. **`bot/index.ts`** — update pending state keys
7. **`trade.ts`** — `dispatchInstructions` batching (isolated, test separately)

---

## 6. Tests to update / add

| Test | What to change |
|------|---------------|
| `tests/unit/services/preflight.test.ts` | Add test: `PRICE_DRIFT` error when anchor 1% off |
| `tests/unit/services/lots.test.ts` | Add test: `toPrecision(12)` anchor round-trip for micro-cap price |
| `tests/unit/services/market.test.ts` | Add test: `fundingDailyUsd`, `liqDistanceLabel` new helpers |
| New: `tests/unit/bot/trade-flow.test.ts` | Activation gate, balance gate, decimal leverage one-liner |

---

## 7. TODO List

### Phase 0 — Prep (no behaviour change, just groundwork)

#### P0-1: Add fmt helpers
- [x] Open `src/bot/lib/fmt.ts`
- [x] Add `fundingDailyUsd(rateDecimal: number, notionalUsdc: number): string`
  - Computes `|rate| * notional * 3` (3 funding events/day), formats as `$X.XX/day`
- [x] Add `liqDistanceLabel(side: "long"|"short", markPrice: number, liqPrice: number): string`
  - Computes distance %, formats as `"falls 9% to ~$78,300"` or `"rises 9% to ~$95,700"`
- [x] Run `pnpm check` — no lint errors

#### P0-2: Add `checkOrderRateLimit` helper
- [x] Open `src/bot/middleware/rate-limit.ts`
- [x] Add exported async function `checkOrderRateLimit(ctx: BotContext): Promise<boolean>`
  - Increments `ratelimit:orders:<userId>` same as `orderRateLimitMiddleware`
  - On limit exceeded: calls `ctx.answerCallbackQuery(...)` if callback, else `ctx.reply(...)`; returns `false`
  - On pass: returns `true`
- [x] Keep existing `rateLimitMiddleware` and `orderRateLimitMiddleware` exports unchanged
- [x] Run `pnpm check`

#### P0-3: Update fmt unit tests
- [x] Open `tests/unit/services/market.test.ts` (or create `tests/unit/lib/fmt.test.ts`)
- [x] Add test: `fundingDailyUsd(0.0001, 1000)` → `"$0.30/day"` (0.0001 * 1000 * 3)
- [x] Add test: `fundingDailyUsd(-0.0001, 1000)` → `"$0.30/day"` (absolute value)
- [x] Add test: `liqDistanceLabel("long", 87000, 78300)` → contains `"falls"` and `"10"` and `"78,300"`
- [x] Add test: `liqDistanceLabel("short", 87000, 95700)` → contains `"rises"`
- [x] Run `pnpm test` — all pass

---

### Phase 1 — Keyboards redesign

#### P1-1: Rewrite `sizePickerKeyboard`
- [x] Open `src/bot/keyboards/trade.ts`
- [x] Remove `lev` parameter from `sizePickerKeyboard` signature
- [x] Change button label format from `"${p}%  ${usd(amt)}"` to `"${usd(amt)}  (${p}%)"`
- [x] Change callback data from `trade_size:${side}:${symbol}:${lev}:${amt.toFixed(2)}` to `trade_size:${side}:${symbol}:${amt}`
  - Use `parseFloat(((available * p) / 100).toFixed(2))` for `amt` to avoid floating point noise
- [x] Change "Custom amount" callback from `trade_size_custom:${side}:${symbol}:${lev}` to `trade_size_custom:${side}:${symbol}`
- [x] Change "← Back" callback from `trade:${side}:${symbol}` (same, unchanged)
- [x] Run `pnpm check`

#### P1-2: Rewrite `leveragePickerKeyboard`
- [x] Add `sizeUsdc: number` and `markPrice: number` parameters
- [x] Remove `markPrice` parameter (was not there before — it's a new addition)
- [x] Change button label format from `"${l}x"` / `"★${l}x"` to `"★${l}× · ${usd(sizeUsdc * l, 0, 0)}"` / `"${l}× · ${usd(sizeUsdc * l, 0, 0)}"`
- [x] Change callback data from `trade_lev:${side}:${symbol}:${l}` to `trade_lev:${side}:${symbol}:${sizeUsdc}:${l}`
- [x] Change "Custom" callback from `trade_lev_custom:${side}:${symbol}` to `trade_lev_custom:${side}:${symbol}:${sizeUsdc}`
- [x] Change button row layout from `count % 3 === 0` to `count % 2 === 0` (2-per-row, wider labels need more space)
- [x] Run `pnpm check`

#### P1-3: Verify callback data lengths
- [x] Manually check worst-case lengths for each new pattern (see §7 audit table)
- [x] Confirm all are under 64 bytes
- [x] Pay special attention to `confirm:long:SYMBOL:LEV:AMT:ANCHOR` with `toPrecision(12)` anchor

---

### Phase 2 — `long.ts` rewrite

#### P2-1: Rename and refactor `sendLeveragePicker` → `sendSizeStep`
- [x] Open `src/bot/commands/long.ts`
- [x] Rename function `sendLeveragePicker` to `sendSizeStep`
- [x] Remove `lev` / leverage-related parameters
- [x] Change signature to `sendSizeStep(ctx, side, symbol)`
- [x] Add isolated-only gate (move from old `sendLeveragePicker` — already there)
- [x] Add `getMarketSnapshot` call (already there — keep)
- [x] Replace `getTraderState` call: it was in `sendSizePicker`, move here
- [x] Add **balance gate**: if `available <= 0`, show deposit CTA and return early
  - Message: `"You have no funds to trade with.\n\nDeposit USDC to get started."`
  - Button: `"📥 Deposit USDC"` → `"nav:deposit"`
- [x] Replace funding rate display: remove `fundingApr()` + `fundingDir()`, add daily cost note (only if `dailyUsd > 0.05`)
  - Message format: `"💸 Funding costs you ≈$X.XX/day at Yx (varies by leverage)"`
  - Only show if `snapshot.fundingRate > 0` for longs (longs pay) or `< 0` for shorts (shorts pay)
- [x] Replace keyboard call: `leveragePickerKeyboard(...)` → `sizePickerKeyboard(side, symbol, available)`
- [x] Update message text: `"Your balance: $X.XX\n\nHow much do you want to risk?"` instead of `"Select your leverage:"`
- [x] Export `sendSizeStep` (keep exported, `short.ts` uses it)
- [x] Run `pnpm check`

#### P2-2: Rename and refactor `sendSizePicker` → `sendLevStep`
- [x] Rename function `sendSizePicker` to `sendLevStep`
- [x] Change signature to `sendLevStep(ctx, side, symbol, sizeUsdc)`
- [x] Remove `lev` parameter (size is now the input, not leverage)
- [x] Keep `getMarketSnapshot` call
- [x] Keep `getTraderState` call — but only for settings fetch (`defaultLeverage`), not balance (balance no longer needed here)
  - Actually replace: fetch `userSettings` via `db.query.userSettings.findFirst(...)` (same as old `sendLeveragePicker` did)
  - Remove `getTraderState` call from this function
- [x] Add warning if `sizeUsdc > available` — edge case where balance changed between screens
  - Refetch `getTraderState`, if `sizeUsdc > effectiveCollateral`, show "Your balance changed. Please start again." with back button
- [x] Replace keyboard call: `sizePickerKeyboard(...)` → `leveragePickerKeyboard(side, symbol, sizeUsdc, snapshot.markPrice, snapshot.maxLeverage, settings.defaultLeverage)`
- [x] Update message text: `"Risking $X.XX. Pick your multiplier — buttons show what you'd control:"` instead of `"How much margin do you want to use?"`
- [x] Remove leverage cap warning (caps now built into keyboard — buttons filtered by maxLeverage)
- [x] Export `sendLevStep`
- [x] Run `pnpm check`

#### P2-3: Update `sendTradeConfirm` wording
- [x] Change `entry.toFixed(8)` to `entry.toPrecision(12)` in confirm button callback data (Bug C fix)
- [x] Change "Position value" label → `"You control:"`
- [x] Change "Your margin" label → `"You risk:"`
- [x] Change "Total cost" label → `"You pay:"` (margin + fee)
- [x] Change fee line from `usd(feeUsdc)` to `"${usd(feeUsdc)} (${feePct}%)"` where `feePct = (feeUsdc/notional*100).toFixed(3)`
- [x] Change liq line from `"Liquidated if price ${dirWord} to ${fmtPrice(liqPrice)} (-${liqPct}%)"` to `"Stop-out if price ${liqDistanceLabel(side, entry, liqPrice)}"`
- [x] Replace funding line: remove `fundingApr()` calculation, add `fundingDailyUsd()` based result
  - Show `"💸 Daily holding cost: $X.XX/day"` if user pays
  - Show `"💰 Daily funding income: $X.XX/day (rate in your favour)"` if user receives
  - Show nothing if `dailyCost < 0.01`
- [x] Remove `absApr > 10` funding warning (replaced by above)
- [x] Change confirm button label from `"✅ Open trade"` to `"✅ ${label} ${usd(notional, 0, 0)} of ${symbol}"`
  - e.g. `"✅ Long $1,250 of BTC"`
- [x] Add `edit` parameter (`edit = false`) to function signature
- [x] If `edit && ctx.callbackQuery`: use `ctx.editMessageText(...)` instead of `ctx.reply(...)`
- [x] Add `"(Quote based on current price)"` italic footer line
- [x] Export `sendTradeConfirm` (already exported)
- [x] Run `pnpm check`

#### P2-4: Update `bot.command("long")` entry handler
- [x] Add activation gate at top of handler (after `!ctx.user` guard):
  ```
  if (!ctx.user.phoenixActivated) → show "not activated" message + /activate button, return
  ```
- [x] Change guided flow entry: replace `sendLeveragePicker(ctx, "long", symbol)` with `sendSizeStep(ctx, "long", symbol)`
- [x] Improve one-liner validation message to mention decimal leverage support (Bug D fix)
- [x] Add `!Number.isFinite(lev)` check alongside `Number.isNaN(lev)` (Bug D fix)
- [x] Run `pnpm check`

#### P2-5: Update `trade:long:SYMBOL` callback
- [x] Add activation gate (same as command entry):
  ```
  if (!ctx.user.phoenixActivated) → reply with activation message, return
  ```
- [x] Change call from `sendLeveragePicker(ctx, "long", ctx.match[1])` to `sendSizeStep(ctx, "long", ctx.match[1])`
- [x] Run `pnpm check`

#### P2-6: Replace `trade_lev:long:...` callback (now handles size selection)
- [x] Change regex from `/^trade_lev:long:([A-Z0-9]+):([\d.]+)$/` to `/^trade_size:long:([A-Z0-9]+):([\d.]+)$/`
- [x] Change call from `sendSizePicker(ctx, "long", ctx.match[1], Number(ctx.match[2]))` to `sendLevStep(ctx, "long", ctx.match[1], Number(ctx.match[2]))`
- [x] Run `pnpm check`

#### P2-7: Replace `trade_lev_custom:long:...` callback (now handles custom size)
- [x] Change regex from `/^trade_lev_custom:long:([A-Z0-9]+)$/` to `/^trade_size_custom:long:([A-Z0-9]+)$/`
- [x] Remove `getMarketSnapshot` call + `maxLev` — not needed for size prompt
- [x] Change prompt message from `"Enter your leverage for ${symbol} (1–${maxLev}x):"` to `"Enter the amount you want to risk (USD):\n(Your balance: $X.XX)"`
  - Add `getTraderState` call to show live balance in prompt
- [x] Change `setPending` key from `trade_leverage:long:${symbol}` to `trade_size_input:long:${symbol}`
- [x] Run `pnpm check`

#### P2-8: Replace `trade_size:long:...` callback (now handles leverage selection)
- [x] Change regex from `/^trade_size:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/` to `/^trade_lev:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/`
- [x] Update destructuring: `[symbol, amtStr, levStr] = ctx.match.slice(1)` (amt before lev, matching new callback data order)
- [x] Change call from `sendTradeConfirm(ctx, "long", symbol, lev, amt)` to `sendTradeConfirm(ctx, "long", symbol, Number(levStr), Number(amtStr))`
- [x] Run `pnpm check`

#### P2-9: Replace `trade_size_custom:long:...` callback (now handles custom leverage)
- [x] Change regex from `/^trade_size_custom:long:([A-Z0-9]+):([\d.]+)$/` to `/^trade_lev_custom:long:([A-Z0-9]+):([\d.]+)$/`
- [x] Update destructuring: `[symbol, amtStr] = ctx.match.slice(1)`
- [x] Add `getMarketSnapshot` call to get `maxLev` for the prompt message
- [x] Change prompt message from `"Enter the margin amount in USD:..."` to `"Enter your leverage for ${symbol} (1–${maxLev}×):"`
- [x] Change `setPending` key from `trade_size:long:${symbol}:${levStr}` to `trade_lev_input:long:${symbol}:${amtStr}`
- [x] Run `pnpm check`

#### P2-10: Update `confirm:long:...` callback
- [x] Add `checkOrderRateLimit(ctx)` as first check after `ctx.user` guard (Bug A fix)
  - `if (!await checkOrderRateLimit(ctx)) return;`
- [x] Add import for `checkOrderRateLimit` from rate-limit middleware
- [x] In preflight catch block: add `PRICE_DRIFT` special case BEFORE the generic error handler
  - Show `"⚠️ Price moved..."` message
  - Button: `"🔄 Refresh price"` → `trade_refresh:long:${symbol}:${lev}:${sizeUsdc}`
  - Button: `"✕ Cancel"` → `"cancel"`
  - Return early (Bug E fix)
- [x] In success handler: update message wording
  - Hero line: `"✅ Opened — Long ${usd(notional, 0, 0)} of ${symbol}"` (not `"Trade opened!"`)
  - Add stop-loss nudge: `"⚠️ No stop loss set. If price ${liqDistanceLabel(...)} you get stopped out."`
  - Buttons: primary = `"🛑 Set stop loss"`, secondary = `"📊 View position"`
  - Move Solscan link to message body (not a button) using `FormattedString.link("Solscan ↗", ...)`
- [x] Run `pnpm check`

#### P2-11: Add `trade_refresh:long:...` callback (new)
- [x] Register new callback `/^trade_refresh:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/`
- [x] Destructure: `[symbol, levStr, amtStr]`
- [x] Call `sendTradeConfirm(ctx, "long", symbol, Number(levStr), Number(amtStr), true)` with `edit: true`
- [x] Answer callback query with `"Refreshing…"` before the call
- [x] Run `pnpm check`

#### P2-12: Update `sendSymbolPicker` (minor)
- [x] Add parallel price fetch: `Promise.allSettled(popular.map(s => getMarketSnapshot(s)))`
- [x] Include price in button label: `"BTC $87,000"` when snapshot available, `"BTC"` on failure
- [x] Change label from `"Buy / Long"` / `"Sell / Short"` to just `"Long"` / `"Short"`
- [x] Run `pnpm check`

---

### Phase 3 — `short.ts` updates

#### P3-1: Update imports
- [x] Open `src/bot/commands/short.ts`
- [x] Replace `sendLeveragePicker` import with `sendSizeStep`
- [x] Add `sendLevStep` import
- [x] Keep `sendSymbolPicker`, `sendTradeConfirm` imports (unchanged)

#### P3-2: Update `bot.command("short")` entry
- [x] Add activation gate (identical to long.ts P2-4)
- [x] Change guided entry call to `sendSizeStep(ctx, "short", symbol)`
- [x] Add `!Number.isFinite(lev)` to one-liner validation (Bug D)
- [x] Update one-liner error message to mention decimal leverage

#### P3-3: Update `trade:short:SYMBOL` callback
- [x] Add activation gate
- [x] Change call to `sendSizeStep(ctx, "short", ctx.match[1])`

#### P3-4: Update `trade_lev:short:...` callback
- [x] Change regex to `/^trade_size:short:([A-Z0-9]+):([\d.]+)$/`
- [x] Change call to `sendLevStep(ctx, "short", symbol, amt)`

#### P3-5: Update `trade_lev_custom:short:...` callback
- [x] Change regex to `/^trade_size_custom:short:([A-Z0-9]+)$/`
- [x] Update prompt and `setPending` key to `trade_size_input:short:${symbol}`

#### P3-6: Update `trade_size:short:...` callback
- [x] Change regex to `/^trade_lev:short:([A-Z0-9]+):([\d.]+):([\d.]+)$/`
- [x] Update destructuring order: amt before lev

#### P3-7: Update `trade_size_custom:short:...` callback
- [x] Change regex to `/^trade_lev_custom:short:([A-Z0-9]+):([\d.]+)$/`
- [x] Update prompt to leverage prompt
- [x] Update `setPending` key to `trade_lev_input:short:${symbol}:${amtStr}`

#### P3-8: Update `confirm:short:...` callback
- [x] Add `checkOrderRateLimit(ctx)` check (Bug A)
- [x] Add `PRICE_DRIFT` special case with refresh button (Bug E)
- [x] Update success message wording (same as long)

#### P3-9: Add `trade_refresh:short:...` callback
- [x] Register `/^trade_refresh:short:([A-Z0-9]+):([\d.]+):([\d.]+)$/`
- [x] Call `sendTradeConfirm(ctx, "short", symbol, lev, amt, true)`

---

### Phase 4 — `bot/index.ts` pending-state dispatch

#### P4-1: Update `trade_leverage` → `trade_size_input` branch
- [x] Open `src/bot/index.ts`
- [x] Find `if (parts[0] === "trade_leverage")` block
- [x] Change key check to `parts[0] === "trade_size_input"`
- [x] Remove `lev` parsing — this branch now parses a dollar `size` amount
  - `const size = parseAmount(text)`
  - Validate: `Number.isNaN(size) || size <= 0`
  - Error message: `"Invalid amount. Enter a USD value like 100."`
- [x] Change function call from `sendSizePicker(ctx, side, symbol, lev)` to `sendLevStep(ctx, side, symbol, size)`
- [x] Update imports: remove `sendSizePicker`, ensure `sendLevStep` imported from `./commands/long.js`

#### P4-2: Update `trade_size` → `trade_lev_input` branch
- [x] Find `if (parts[0] === "trade_size")` block
- [x] Change key check to `parts[0] === "trade_lev_input"`
- [x] `parts[3]` now holds the amount (`amtStr`), not leverage
  - `const amt = Number(parts[3])`
  - `const lev = parseLeverage(text)` (parse leverage from user text)
  - Validate: `Number.isNaN(lev) || lev < 1 || !Number.isFinite(lev)`
  - Error message: `"Invalid leverage. Enter a number like 10 or 2.5 (minimum 1)."`
- [x] Change function call from `sendTradeConfirm(ctx, side, symbol, lev, size)` to `sendTradeConfirm(ctx, side, symbol, lev, amt)`

#### P4-3: Update imports at top of `bot/index.ts`
- [x] Remove `sendSizePicker` from `long.js` import
- [x] Add `sendLevStep` to `long.js` import
- [x] Verify `sendSizeStep` is imported (used by `nav:long` / `nav:short` callbacks in `commands/index.ts`)

---

### Phase 5 — `commands/index.ts` nav callbacks

#### P5-1: Update `nav:long` and `nav:short` callbacks
- [x] Open `src/bot/commands/index.ts`
- [x] Find `bot.callbackQuery("nav:long", ...)` — currently calls `sendSymbolPicker(ctx, "long")`
  - No change needed here: `sendSymbolPicker` is still the right entry for these nav buttons
- [x] Update import: replace `sendSizePicker` (if imported) with `sendSizeStep` or remove if unused
- [x] Verify `sendSymbolPicker` export still exists in `long.ts` after refactor

---

### Phase 6 — `trade.ts` dispatch batching (Bug F)

#### P6-1: Refactor `dispatchInstructions`
- [x] Open `src/services/phoenix/trade.ts`
- [x] Find `dispatchInstructions` function (currently a sequential loop)
- [x] Add fast path: if `ixs.length === 1`, call `dispatchInstruction(ixs[0], walletAddress)` and return (no change for single-instruction case)
- [x] For multi-instruction path:
  - Call `getSigner` once
  - Call `getBlockhash` once
  - Map all `ixs` through `addSignersToInstruction([signer], ix)`
  - Build one transaction with all signed instructions between compute budget and Jito tip
  - Sign, encode, send via Helius sender, poll confirmation
  - Return single signature
- [x] Verify `COMPUTE_UNIT_LIMIT = 250_000` is still sufficient for multiple TP/SL instructions in one tx
  - If not: increase to `400_000` or make it dynamic based on `ixs.length`
- [x] Run `pnpm check`

#### P6-2: Smoke test TP/SL batching
- [x] Manually verify `setTpSl` with both TP + SL levels still produces one tx signature (not two)
- [x] Verify ladder TP (3 levels) produces one tx with 3 instructions (not 3 txs)

---

### Phase 7 — Tests

#### P7-1: Update existing unit tests
- [x] Open `tests/unit/services/preflight.test.ts`
  - Add test: `PRICE_DRIFT` thrown when anchor price drifts > slippage tolerance
  - Add test: no `PRICE_DRIFT` when no `anchorPrice` passed (confirm-screen render path)
- [x] Open `tests/unit/services/lots.test.ts`
  - Add test: `marginToTokens` with anchor price using `toPrecision(12)` round-trip for price `0.00000123456789`
  - Verify no significant precision loss after parse → `toPrecision(12)` → `Number()`

#### P7-2: Add fmt tests
- [x] Create or update `tests/unit/lib/fmt.test.ts`
- [x] `fundingDailyUsd(0.0001, 10000)` → `"$3.00/day"`
- [x] `fundingDailyUsd(-0.0002, 5000)` → `"$3.00/day"` (absolute value)
- [x] `fundingDailyUsd(0, 10000)` → `"$0.00/day"`
- [x] `liqDistanceLabel("long", 100, 90)` → `"falls 10% to ~$90.00"`
- [x] `liqDistanceLabel("short", 100, 110)` → `"rises 10% to ~$110.00"`

#### P7-3: Add trade-flow unit tests
- [x] Create `tests/unit/bot/trade-flow.test.ts`
- [x] Test: activation gate blocks entry when `phoenixActivated = false`
  - Mock `ctx.user` with `phoenixActivated: false`
  - Verify reply contains activate instruction
- [x] Test: balance gate blocks `sendSizeStep` when `effectiveCollateral = 0`
  - Mock `getTraderState` returning `effectiveCollateral: "0"`
  - Verify reply contains deposit CTA
- [x] Test: one-liner decimal leverage accepted — `parseLeverage("2.5x") = 2.5`, `!isNaN`, `>= 1`
- [x] Test: one-liner `Infinity` leverage rejected — `parseLeverage("Infinityx")` should fail `!isFinite` check
- [x] Test: `checkOrderRateLimit` returns `false` on 6th call within window

#### P7-4: Run full test suite
- [x] `pnpm test` — all unit tests pass
- [x] `pnpm check` — no lint/format errors
- [x] `pnpm build` — TypeScript compiles clean

---

### Phase 8 — Manual smoke tests (in dev/polling mode)

#### P8-1: Happy path — guided flow
- [ ] `/long` → symbol picker shows prices on buttons
- [ ] Tap `BTC $87,000` → size step shows balance + `$X (10%)` style buttons
- [ ] Tap `$125 (25%)` → leverage step shows `"10× · $1,250"` style buttons with ★ on default
- [ ] Tap `10× · $1,250` → confirm screen: "You risk / You control / Fee / Stop-out if..."
- [ ] Verify confirm button label: `"✅ Long $1,250 of BTC"`
- [ ] Tap confirm → success screen with SL nudge + "🛑 Set stop loss" button
- [ ] Same flow for `/short`

#### P8-2: Happy path — one-liner
- [ ] `/long BTC 10x 500` → skips pickers, shows confirm screen directly
- [ ] `/long BTC 2.5x 100` → decimal leverage accepted, confirm shows `2.5×`
- [ ] `/short ETH 5x 200` → works symmetrically

#### P8-3: Custom inputs
- [ ] Size picker → `"Enter custom amount"` → type `150` → lever step shows `150` as context
- [ ] Lever step → `"Enter custom"` → type `7` → confirm shows `7×`
- [ ] Lever step → `"Enter custom"` → type `7.5` → confirm shows `7.5×`

#### P8-4: Edge cases
- [ ] Not activated user → `/long` → sees activation message, not symbol picker
- [ ] Not activated user → tap `"🟢 Long"` from /start screen → same activation message
- [ ] Zero balance → symbol picker → tap BTC → sees deposit message, not size step
- [ ] Isolated market → tap GOLD → sees "isolated margin not available" message
- [ ] Unknown market → `/long FAKECOIN 5x 100` → `"Market not found"` message

#### P8-5: Price drift
- [ ] Force-trigger `PRICE_DRIFT` (temporarily lower `slippageBps` to 1 in settings, or mock)
- [ ] Verify confirm screen shows `"🔄 Refresh price"` button (not "Re-open the trade")
- [ ] Tap `"🔄 Refresh price"` → confirm screen re-renders in-place with new price

#### P8-6: Rate limiting
- [ ] Submit 6 confirm callbacks in rapid succession
- [ ] 6th attempt → receives `"Too many orders. Wait a minute."` via `answerCallbackQuery`
- [ ] Verify first 5 attempts are not blocked

#### P8-7: Navigation / back buttons
- [ ] Leverage step → `"← Back"` → returns to symbol picker (correct)
- [ ] Size step → `"← Back"` → returns to symbol picker (correct)
- [ ] Cancel at any step → message replaced with `"Cancelled."`

---

### Phase 9 — Cleanup

#### P9-1: Remove dead code
- [x] Delete `sendLeveragePicker` export from `long.ts` (renamed to `sendSizeStep` — check no other file imports the old name)
- [x] Delete `sendSizePicker` export from `long.ts` (renamed to `sendLevStep` — check no other file imports it)
- [x] Search repo for any remaining references to old pending keys `"trade_leverage:"` and `"trade_size:"` (except in regexes that are now updated)
- [x] Search for `fundingApr` usages in long.ts / short.ts — remove those calls (replaced by daily cost)
- [x] Search for `fundingDir` usages in long.ts / short.ts — remove (replaced)

#### P9-2: Update CLAUDE.md known bugs section
- [x] Open `CLAUDE.md`
- [x] Remove bugs 3, 4, 5, 6, 7 from "Known bugs" Phase 0 list (those are now fixed)
- [x] Add note: "Trade flow redesigned — size-first order, see plan.md"

#### P9-3: Final build + lint
- [x] `pnpm check` — clean
- [x] `pnpm build` — clean
- [x] `pnpm test` — all pass

---

## 7. Callback data length audit

Telegram max callback_data is **64 bytes**. Worst-case new patterns:

| Pattern | Example | Length |
|---------|---------|--------|
| `trade_size:long:SYMBOL:AMT` | `trade_size:long:AAABBB:10000.00` | 32 |
| `trade_lev:long:SYMBOL:AMT:LEV` | `trade_lev:long:AAABBB:10000.00:100` | 36 |
| `confirm:long:SYMBOL:LEV:AMT:ANCHOR` | `confirm:long:AAABBB:100:10000.00:0.000987654321` | 47 |
| `trade_refresh:long:SYMBOL:LEV:AMT` | `trade_refresh:long:AAABBB:100:10000.00` | 40 |
| `trade_lev_custom:long:SYMBOL:AMT` | `trade_lev_custom:long:AAABBB:10000.00` | 39 |

All under 64 bytes. ✓

Symbol max is 6 chars (e.g., `WTIOIL` — but that's isolated-only so won't appear in this flow). Safe.
