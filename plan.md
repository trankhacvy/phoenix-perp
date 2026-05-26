# Plan: Settings Command Redesign

## Goal

Replace the minimal 2-option settings screen with a Trojan-style settings panel covering: slippage, leverage, priority fees, trade confirmation toggle, close confirmation toggle, and auto TP/SL defaults.

---

## 1. Settings Screen Layout

```
⚙️ Settings

━━ Trade Defaults ━━
Slippage         0.5%
Default Leverage 5×
Auto TP          Off
Auto SL          Off

━━ Execution ━━
Priority Fee     ⚡ Normal
Confirm Trades   🟢 On
Confirm Close    🟢 On

[🔔 Manage Alerts]  [← Close]
```

### Keyboard Layout (main screen)

```
Row 1:  [ Slippage: 0.5% ✏️ ]    [ Leverage: 5× ✏️ ]
Row 2:  [ Auto TP: Off ✏️ ]      [ Auto SL: Off ✏️ ]
Row 3:  [ ⚡ Normal ]  [ 🔥 Turbo ]  [ 🌿 Eco ]  [ ✏️ Custom ]
Row 4:  [ Confirm Trades: 🟢 ]   [ Confirm Close: 🟢 ]
Row 5:  [ 🔔 Alerts ]            [ ✕ Close ]
```

Priority fee row: the active mode is highlighted with ★. Tapping a different one saves immediately (no sub-screen). Custom opens a text prompt.

Toggle buttons: tap to flip. Red 🔴 = off, green 🟢 = on. Saves immediately, re-renders settings screen.

Slippage, Leverage, Auto TP, Auto SL: tap opens sub-screen (same as current), then returns to main.

---

## 2. Sub-Screens

### 2a. Slippage (existing — keep as-is)

```
Select slippage tolerance:
[ 0.1% ] [ 0.3% ] [ 0.5% ★ ] [ 1.0% ] [ 2.0% ]
[ ← Back ]
```

### 2b. Default Leverage (existing — keep as-is)

```
Select default leverage:
[ 2× ] [ 3× ] [ 5× ★ ] [ 10× ] [ 20× ] [ 50× ]
[ ← Back ]
```

### 2c. Auto TP

```
Set default Take Profit for new trades:

When set, TP is automatically placed after each trade opens.

[ +5% ] [ +10% ★ ] [ +25% ] [ +50% ]
[ ✏️ Custom % ]
[ 🗑 Off — no auto TP ]
[ ← Back ]
```

### 2d. Auto SL

```
Set default Stop Loss for new trades:

When set, SL is automatically placed after each trade opens.

[ -2% ] [ -5% ★ ] [ -10% ] [ -15% ]
[ ✏️ Custom % ]
[ 🗑 Off — no auto SL ]
[ ← Back ]
```

### 2e. Custom Priority Fee

```
Enter your priority fee in SOL (e.g. 0.003):

This sets BOTH the compute unit price and Jito tip.

Presets:
  Eco    = 0.0006 SOL
  Normal = 0.0015 SOL
  Turbo  = 0.0075 SOL

Send a number:
[ ← Back ]
```

---

## 3. Confirm Trades — Behavior

When **OFF** (🔴):
- After user picks leverage in the trade flow, **skip the confirm screen** and go straight to execution.
- The leverage picker button fires the confirm callback directly instead of calling `sendTradeConfirm()`.
- Show a small warning when user first disables: "Trades will execute immediately after picking leverage. No confirmation step."

When **ON** (🟢, default):
- Current behavior — size → leverage → confirm → execute.

### Implementation detail

In `sendLevStep()` and the `trade_lev:` callback handlers, after the user picks leverage:

```typescript
// Current: always show confirm screen
await sendTradeConfirm(ctx, side, symbol, lev, sizeUsdc);

// New: check settings
const settings = await getSettings(ctx.user.id);
if (settings.confirmTrades) {
  await sendTradeConfirm(ctx, side, symbol, lev, sizeUsdc);
} else {
  // Skip confirm — execute directly via the confirm callback logic
  // Need to build a synthetic callback or extract execution into a shared function
  await executeTradeDirectly(ctx, side, symbol, lev, sizeUsdc);
}
```

The cleanest approach: extract the trade execution logic from the `confirm:long:` / `confirm:short:` callback handlers into a shared `executeTrade()` function that both the confirm callback and the skip-confirm path can call.

---

## 4. Confirm Close — Behavior

When **OFF** (🔴):
- Tapping "Close 25%" / "Close 50%" / "Close 100%" in position detail **skips the confirm prompt** and goes straight to execution.
- The `close:SYMBOL:PCT:SIDE` callback goes directly to `closePosition()` instead of showing the confirm screen.

When **ON** (🟢, default):
- Current behavior — confirm prompt before close.

---

## 5. Auto TP/SL — Behavior

After a trade opens successfully (in the async IIFE in `long.ts` / `short.ts`), if the user has auto TP/SL configured:

```typescript
// After placeMarketOrder succeeds:
const sig = await placeMarketOrder(...);

// Auto TP/SL
const settings = await getSettings(user.id);
if (settings.autoTpPct || settings.autoSlPct) {
  const entryPrice = pf.snapshot.markPrice;
  const tpPrice = settings.autoTpPct
    ? side === "long"
      ? entryPrice * (1 + settings.autoTpPct / 100)
      : entryPrice * (1 - settings.autoTpPct / 100)
    : undefined;
  const slPrice = settings.autoSlPct
    ? side === "long"
      ? entryPrice * (1 - settings.autoSlPct / 100)
      : entryPrice * (1 + settings.autoSlPct / 100)
    : undefined;

  try {
    await setTpSl({
      symbol,
      walletAddress: wallet,
      positionSide: side,
      tpPrice,
      slPrice,
      tpMode: "limit",
      slMode: "market",
    });
  } catch (err) {
    logger.warn({ err, symbol }, "Auto TP/SL failed (non-fatal)");
    // Don't fail the trade — just warn
  }
}
```

Non-fatal: if auto TP/SL fails, trade still succeeds. User gets a note in the success message.

---

## 6. Priority Fee — Behavior

### Fee modes

| Mode | Priority Fee (SOL) | Jito Tip (SOL) | Total extra cost |
|------|-------------------|----------------|-----------------|
| Eco | 0.0006 | 0.0006 | ~0.0012 SOL |
| Normal | 0.0015 | 0.0015 | ~0.0030 SOL |
| Turbo | 0.0075 | 0.0075 | ~0.0150 SOL |
| Custom | user-defined | same as priority | 2× user value |

### Conversion to existing constants

Current code uses:
- `COMPUTE_UNIT_PRICE` = 200,000 microlamports per CU
- `JITO_TIP_LAMPORTS` = 200,000 lamports (= 0.0002 SOL)
- `COMPUTE_UNIT_LIMIT` = 250,000 CUs

The Trojan-style fee is simpler: one SOL number covers everything. We split it:
- **Jito tip** = the SOL amount directly → convert to lamports
- **Compute unit price** = derive from the same SOL amount. With 250K CU limit: `microLamports = (solAmount * 1e9) / 250_000 * 1e6`

Actually, simpler approach — keep it like Trojan: the SOL amount IS the Jito tip. Priority fee stays a reasonable fixed value (or scale proportionally).

```typescript
// Fee presets in lamports
const FEE_PRESETS = {
  eco:    { tipLamports: 600_000n,    cuPrice: 100_000 },   // 0.0006 SOL tip
  normal: { tipLamports: 1_500_000n,  cuPrice: 200_000 },   // 0.0015 SOL tip
  turbo:  { tipLamports: 7_500_000n,  cuPrice: 1_000_000 }, // 0.0075 SOL tip
} as const;

// Custom: user enters SOL → convert
function customFee(solAmount: number) {
  const tipLamports = BigInt(Math.round(solAmount * 1e9));
  const cuPrice = Math.round((solAmount * 1e9) / 250_000 * 1e6);
  return { tipLamports, cuPrice: Math.max(cuPrice, 10_000) };
}
```

### Threading through to trade.ts

The `sendInstruction()` function currently uses hardcoded constants. Change it to accept fee params:

```typescript
// Before
const JITO_TIP_LAMPORTS = 200_000n;
const COMPUTE_UNIT_PRICE = 200_000;

// After — accept as parameter, with defaults for backward compat
interface FeeConfig {
  tipLamports: bigint;
  cuPrice: number;
}

const DEFAULT_FEE: FeeConfig = { tipLamports: 1_500_000n, cuPrice: 200_000 };

async function sendInstruction(
  ix: AnyInstruction,
  signer: TransactionPartialSigner,
  fee: FeeConfig = DEFAULT_FEE,
): Promise<string> {
  // ... use fee.tipLamports and fee.cuPrice instead of constants
}
```

Then all public functions (`placeMarketOrder`, `closePosition`, `depositCollateral`, etc.) accept an optional `feeConfig` param. The bot command handlers read the user's setting and pass it down.

---

## 7. DB Schema Changes

### `src/db/schema/settings.ts` — new columns

```typescript
import { boolean, integer, numeric, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const feeModePgEnum = pgEnum("fee_mode", ["eco", "normal", "turbo", "custom"]);

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  slippageBps: integer("slippage_bps").default(50).notNull(),
  defaultLeverage: integer("default_leverage").default(5).notNull(),

  // New columns
  confirmTrades: boolean("confirm_trades").default(true).notNull(),
  confirmClose: boolean("confirm_close").default(true).notNull(),
  feeMode: feeModePgEnum("fee_mode").default("normal").notNull(),
  customFeeSol: numeric("custom_fee_sol", { precision: 12, scale: 9 }),
  autoTpPct: numeric("auto_tp_pct", { precision: 5, scale: 2 }),
  autoSlPct: numeric("auto_sl_pct", { precision: 5, scale: 2 }),

  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserSettings = typeof userSettings.$inferSelect;
```

### Migration SQL

```sql
DO $$ BEGIN
  CREATE TYPE "fee_mode" AS ENUM ('eco', 'normal', 'turbo', 'custom');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "confirm_trades" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "confirm_close" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "fee_mode" "fee_mode" NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS "custom_fee_sol" numeric(12, 9),
  ADD COLUMN IF NOT EXISTS "auto_tp_pct" numeric(5, 2),
  ADD COLUMN IF NOT EXISTS "auto_sl_pct" numeric(5, 2);
```

---

## 8. Files to Change

### Core changes (ordered by dependency)

| # | File | What |
|---|------|------|
| 1 | `src/db/schema/settings.ts` | Add 5 columns + fee_mode enum |
| 2 | New migration | SQL for new columns |
| 3 | `src/services/phoenix/trade.ts` | Make `sendInstruction` / `dispatchInstruction` / `dispatchInstructions` accept `FeeConfig`. Add `getFeeConfig(feeMode, customFeeSol)` helper. Thread fee through all public functions (`placeMarketOrder`, `closePosition`, `depositCollateral`, `withdrawCollateral`, `setTpSl`, `cancelStopLoss`, `addMargin`, `transferUsdc`) |
| 4 | `src/bot/commands/settings.ts` | Full rewrite — new main screen, sub-screens, toggle callbacks, custom fee input |
| 5 | `src/bot/commands/long.ts` | (a) Read settings for `confirmTrades` — skip confirm if off. (b) After trade success, auto-set TP/SL if configured. (c) Pass `feeConfig` to `placeMarketOrder`. (d) Extract trade execution into shared `executeTrade()` |
| 6 | `src/bot/commands/short.ts` | Same as long.ts — use shared `executeTrade()`, auto TP/SL, fee config |
| 7 | `src/bot/commands/positions.ts` | Read settings for `confirmClose` — skip confirm if off. Pass `feeConfig` to `closePosition` / `addMargin` |
| 8 | `src/bot/commands/deposit.ts` | Pass `feeConfig` to `depositCollateral` |
| 9 | `src/bot/commands/withdraw.ts` | Pass `feeConfig` to `withdrawCollateral` / `transferUsdc` |
| 10 | `src/bot/commands/setsl.ts` | Pass `feeConfig` to `setTpSl` / `cancelStopLoss` |
| 11 | `src/bot/commands/settp.ts` | Pass `feeConfig` to `setTpSl` / `cancelStopLoss` |
| 12 | `src/bot/index.ts` | Handle pending state for `settings_custom_fee` and `settings_auto_tp` / `settings_auto_sl` |

### No changes needed

- `src/bot/keyboards/trade.ts` — size/leverage pickers stay the same
- `src/bot/keyboards/position.ts` — close buttons stay the same (confirm logic moves to handler)
- `src/services/phoenix/preflight.ts` — no fee config needed here
- `src/services/phoenix/market.ts` — no changes
- `src/services/phoenix/position.ts` — no changes

---

## 9. Detailed Code Snippets

### 9a. Settings helper — `getSettings()` (shared, reusable)

Move out of `settings.ts` command file into a shared service so `long.ts`, `short.ts`, `positions.ts` etc. can import it:

**New file: `src/services/settings.ts`**

```typescript
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { userSettings } from "../db/schema/index.js";

export type FeeMode = "eco" | "normal" | "turbo" | "custom";

export interface Settings {
  slippageBps: number;
  defaultLeverage: number;
  confirmTrades: boolean;
  confirmClose: boolean;
  feeMode: FeeMode;
  customFeeSol: number | null;
  autoTpPct: number | null;
  autoSlPct: number | null;
}

const DEFAULTS: Settings = {
  slippageBps: 50,
  defaultLeverage: 5,
  confirmTrades: true,
  confirmClose: true,
  feeMode: "normal",
  customFeeSol: null,
  autoTpPct: null,
  autoSlPct: null,
};

export async function getSettings(userId: string): Promise<Settings> {
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!row) return DEFAULTS;
  return {
    slippageBps: row.slippageBps,
    defaultLeverage: row.defaultLeverage,
    confirmTrades: row.confirmTrades,
    confirmClose: row.confirmClose,
    feeMode: row.feeMode as FeeMode,
    customFeeSol: row.customFeeSol ? Number(row.customFeeSol) : null,
    autoTpPct: row.autoTpPct ? Number(row.autoTpPct) : null,
    autoSlPct: row.autoSlPct ? Number(row.autoSlPct) : null,
  };
}

export async function saveSettings(
  userId: string,
  patch: Partial<Settings>,
): Promise<Settings> {
  const current = await getSettings(userId);
  const next = { ...current, ...patch };
  await db
    .insert(userSettings)
    .values({ userId, ...next })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ...patch, updatedAt: new Date() },
    });
  return next;
}
```

### 9b. Fee config helper — `src/services/phoenix/trade.ts`

```typescript
export interface FeeConfig {
  tipLamports: bigint;
  cuPrice: number;
}

const FEE_PRESETS: Record<string, FeeConfig> = {
  eco:    { tipLamports:   600_000n, cuPrice:   100_000 },
  normal: { tipLamports: 1_500_000n, cuPrice:   200_000 },
  turbo:  { tipLamports: 7_500_000n, cuPrice: 1_000_000 },
};

export function getFeeConfig(
  mode: string,
  customSol?: number | null,
): FeeConfig {
  if (mode === "custom" && customSol && customSol > 0) {
    const tipLamports = BigInt(Math.round(customSol * 1e9));
    const cuPrice = Math.max(Math.round((customSol * 1e15) / 250_000), 10_000);
    return { tipLamports, cuPrice };
  }
  return FEE_PRESETS[mode] ?? FEE_PRESETS.normal;
}
```

Then update `sendInstruction`:

```typescript
async function sendInstruction(
  ix: AnyInstruction,
  signer: TransactionPartialSigner,
  fee: FeeConfig = FEE_PRESETS.normal,
): Promise<string> {
  const latestBlockhash = await getBlockhash();
  const tipAccount = JITO_TIP_ACCOUNTS[
    Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)
  ] as Address;

  const signedIx = addSignersToInstruction([signer], ix);

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitPriceInstruction({ microLamports: fee.cuPrice }),
          getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
          signedIx,
          getTransferSolInstruction({
            source: signer,
            destination: tipAccount,
            amount: lamports(fee.tipLamports),
          }),
        ],
        tx,
      ),
  );
  // ... rest unchanged
}
```

Update all public functions to accept optional `fee`:

```typescript
export async function placeMarketOrder(
  params: MarketOrderParams,
  fee?: FeeConfig,
): Promise<string> {
  // ... build ix ...
  return dispatchInstruction(ix, params.walletAddress, fee);
}
```

### 9c. Settings screen — `src/bot/commands/settings.ts`

```typescript
function settingsMsg(s: Settings): FormattedString {
  const feeLabel = s.feeMode === "custom" && s.customFeeSol
    ? `Custom (${s.customFeeSol} SOL)`
    : { eco: "🌿 Eco", normal: "⚡ Normal", turbo: "🔥 Turbo" }[s.feeMode];

  const tpLabel = s.autoTpPct ? `+${s.autoTpPct}%` : "Off";
  const slLabel = s.autoSlPct ? `-${s.autoSlPct}%` : "Off";
  const confirmIcon = (v: boolean) => v ? "🟢 On" : "🔴 Off";

  return fmt`⚙️ ${FormattedString.b("Settings")}

━━ ${FormattedString.b("Trade Defaults")} ━━
Slippage           ${FormattedString.code(`${s.slippageBps / 100}%`)}
Default Leverage   ${FormattedString.code(`${s.defaultLeverage}×`)}
Auto TP            ${FormattedString.code(tpLabel)}
Auto SL            ${FormattedString.code(slLabel)}

━━ ${FormattedString.b("Execution")} ━━
Priority Fee       ${FormattedString.code(feeLabel)}
Confirm Trades     ${confirmIcon(s.confirmTrades)}
Confirm Close      ${confirmIcon(s.confirmClose)}`;
}

function settingsKeyboard(s: Settings): InlineKeyboard {
  const feeIcon = (mode: string) => s.feeMode === mode ? "★ " : "";

  return new InlineKeyboard()
    // Row 1: slippage + leverage
    .text(`Slippage: ${s.slippageBps / 100}% ✏️`, "settings:slippage")
    .text(`Leverage: ${s.defaultLeverage}× ✏️`, "settings:leverage")
    .row()
    // Row 2: auto TP/SL
    .text(`TP: ${s.autoTpPct ? `+${s.autoTpPct}%` : "Off"} ✏️`, "settings:auto_tp")
    .text(`SL: ${s.autoSlPct ? `-${s.autoSlPct}%` : "Off"} ✏️`, "settings:auto_sl")
    .row()
    // Row 3: fee mode
    .text(`${feeIcon("eco")}🌿 Eco`, "fee:eco")
    .text(`${feeIcon("normal")}⚡ Normal`, "fee:normal")
    .text(`${feeIcon("turbo")}🔥 Turbo`, "fee:turbo")
    .text("✏️", "fee:custom")
    .row()
    // Row 4: toggles
    .text(
      `Confirm Trades: ${s.confirmTrades ? "🟢" : "🔴"}`,
      "settings:toggle_confirm_trades",
    )
    .text(
      `Confirm Close: ${s.confirmClose ? "🟢" : "🔴"}`,
      "settings:toggle_confirm_close",
    )
    .row()
    // Row 5: nav
    .text("🔔 Alerts", "nav:alerts")
    .text("✕ Close", "settings:close");
}
```

### 9d. Callback handlers for toggles + fee

```typescript
// Toggle confirm trades
bot.callbackQuery("settings:toggle_confirm_trades", async (ctx) => {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery();
  const s = await getSettings(ctx.user.id);
  const next = await saveSettings(ctx.user.id, { confirmTrades: !s.confirmTrades });
  const msg = settingsMsg(next);
  await ctx.editMessageText(msg.text, {
    entities: msg.entities,
    reply_markup: settingsKeyboard(next),
  });
});

// Toggle confirm close
bot.callbackQuery("settings:toggle_confirm_close", async (ctx) => {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery();
  const s = await getSettings(ctx.user.id);
  const next = await saveSettings(ctx.user.id, { confirmClose: !s.confirmClose });
  const msg = settingsMsg(next);
  await ctx.editMessageText(msg.text, {
    entities: msg.entities,
    reply_markup: settingsKeyboard(next),
  });
});

// Fee mode — instant save
bot.callbackQuery(/^fee:(eco|normal|turbo)$/, async (ctx) => {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery("Saved");
  const mode = ctx.match[1] as "eco" | "normal" | "turbo";
  const next = await saveSettings(ctx.user.id, { feeMode: mode });
  const msg = settingsMsg(next);
  await ctx.editMessageText(msg.text, {
    entities: msg.entities,
    reply_markup: settingsKeyboard(next),
  });
});

// Custom fee — prompt
bot.callbackQuery("fee:custom", async (ctx) => {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().text("← Back", "settings:back");
  const msg = fmt`Enter priority fee in SOL (e.g. ${FormattedString.code("0.003")}):

This sets both compute price and Jito tip.

Presets for reference:
  🌿 Eco    = 0.0006 SOL
  ⚡ Normal = 0.0015 SOL
  🔥 Turbo  = 0.0075 SOL`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  await setPending(ctx.from.id, "settings_custom_fee");
});
```

### 9e. Pending handler in `src/bot/index.ts`

Add to the `bot.on("message:text")` handler:

```typescript
if (pending === "settings_custom_fee") {
  await clearPending(ctx.from.id);
  const val = parseAmount(text);
  if (Number.isNaN(val) || val <= 0 || val > 1) {
    await ctx.reply("Invalid amount. Enter between 0.0001 and 1 SOL.");
    return;
  }
  const { saveSettings, getSettings } = await import("../services/settings.js");
  const next = await saveSettings(ctx.user.id, {
    feeMode: "custom",
    customFeeSol: val,
  });
  const msg = fmt`✅ Priority fee set to ${FormattedString.code(`${val} SOL`)}`;
  await ctx.reply(msg.text, { entities: msg.entities });
  return;
}

if (pending === "settings_auto_tp") {
  await clearPending(ctx.from.id);
  const val = parseAmount(text);
  if (Number.isNaN(val) || val <= 0 || val > 500) {
    await ctx.reply("Invalid percentage. Enter between 1 and 500.");
    return;
  }
  const { saveSettings } = await import("../services/settings.js");
  await saveSettings(ctx.user.id, { autoTpPct: val });
  await ctx.reply(`✅ Auto TP set to +${val}%`);
  return;
}

if (pending === "settings_auto_sl") {
  await clearPending(ctx.from.id);
  const val = parseAmount(text);
  if (Number.isNaN(val) || val <= 0 || val > 100) {
    await ctx.reply("Invalid percentage. Enter between 1 and 100.");
    return;
  }
  const { saveSettings } = await import("../services/settings.js");
  await saveSettings(ctx.user.id, { autoSlPct: val });
  await ctx.reply(`✅ Auto SL set to -${val}%`);
  return;
}
```

### 9f. Trade flow — skip confirm + auto TP/SL

In `long.ts`, the leverage callback `trade_lev:long:SYMBOL:AMT:LEV`:

```typescript
bot.callbackQuery(/^trade_lev:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, amtStr, levStr] = ctx.match.slice(1);
  const settings = await getSettings(ctx.user.id);

  if (!settings.confirmTrades) {
    // Skip confirm — execute directly
    await executeTradeFromLevPick(ctx, "long", symbol, Number(levStr), Number(amtStr));
    return;
  }
  await sendTradeConfirm(ctx, "long", symbol, Number(levStr), Number(amtStr));
});
```

The `executeTradeFromLevPick()` function would:
1. Run preflight
2. Show "⏳ Submitting..."
3. Execute trade (same IIFE as confirm handler)
4. After success, auto-set TP/SL from settings

### 9g. Close flow — skip confirm

In `positions.ts`, the `close:SYMBOL:PCT:SIDE` handler:

```typescript
bot.callbackQuery(/^close:([A-Z0-9]+):(\d+):(long|short)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const settings = await getSettings(ctx.user.id);

  if (!settings.confirmClose) {
    // Skip confirm — execute directly
    // Reuse the close:exec handler logic
    const [symbol, pctStr, side] = ctx.match.slice(1);
    await executeClose(ctx, symbol, Number(pctStr), side as "long" | "short");
    return;
  }

  // Current confirm flow
  // ... existing code ...
});
```

---

## 10. Implementation Order

```
Step 1: Schema + migration ✅
  - Update src/db/schema/settings.ts ✅
  - Generate migration (pnpm db:generate) ✅ → 0008_dapper_mathemanic.sql

Step 2: Shared settings service ✅
  - Create src/services/settings.ts ✅
  - Move getSettings/saveSettings out of command file ✅

Step 3: Fee config in trade.ts ✅
  - Add FeeConfig type + getFeeConfig() ✅
  - Update sendInstruction / dispatchInstruction / dispatchInstructions ✅
  - Add optional fee param to all public trade functions ✅

Step 4: Settings command rewrite ✅
  - New main screen with all settings ✅
  - Sub-screens for slippage, leverage, auto TP/SL ✅
  - Toggle callbacks for confirms ✅
  - Fee mode instant-switch + custom prompt ✅
  - Pending handlers in bot/index.ts ✅

Step 5: Confirm trades toggle ✅
  - Extract shared executeTrade() from long.ts confirm handler ✅
  - Wire skip-confirm path in leverage callbacks (long.ts + short.ts) ✅
  - Auto TP/SL after trade success ✅

Step 6: Confirm close toggle ✅
  - Extract shared executeClose() from positions.ts ✅
  - Wire skip-confirm path in close callbacks ✅

Step 7: Thread fee config through all commands ✅
  - long.ts, short.ts → placeMarketOrder(params, fee) ✅
  - positions.ts → closePosition(sym, wallet, frac, fee), addMargin(sym, wallet, amt, fee) ✅
  - deposit.ts → depositCollateral(wallet, amt, fee) ✅
  - withdraw.ts → withdrawCollateral(wallet, amt, fee), transferUsdc(from, to, amt, fee) ✅
  - setsl.ts, settp.ts → setTpSl(params, fee), cancelStopLoss(sym, wallet, dir, fee) ✅

ALL STEPS COMPLETE ✅
  - tsc: 0 errors
  - biome: 0 errors
  - vitest: 75/75 tests passing
```

---

## 11. Edge Cases

1. **Custom fee too low** → tx may fail. Minimum: 0.0001 SOL (100K lamports). Validate on input.
2. **Custom fee too high** → user drains SOL. Cap at 1 SOL. Warn above 0.05 SOL.
3. **Auto TP/SL on isolated-only market** → won't happen because trade is blocked before open.
4. **Auto TP/SL fails** → non-fatal. Show warning in success message: "⚠️ Auto SL could not be set. Set manually."
5. **Skip confirm + price drift** → still need drift protection. Run preflight in the skip-confirm path too, show inline refresh if drift exceeds tolerance.
6. **Toggle while mid-flow** → no issue. Settings read at execution time, not cached across steps.
7. **Old users without settings row** → `getSettings()` returns defaults. First save creates the row.
