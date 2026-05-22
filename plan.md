# Implementation Plan — New UX Flows

> Based on `docs/ux-flows.md`. Every change is grounded in the actual source files.
> Work in order — each phase builds on the last.

---

## Conventions used in this doc

- `CB` = callback query data string
- `PS` = Redis pending-state value (`pending:{telegramId}`)
- `→` = "leads to"
- Before/after snippets show the exact lines to change, not whole files

---

## Phase 0 — Shared Infrastructure

These utilities are used by every command. Build them first.

---

### 0.1 Formatting helpers — `src/bot/lib/fmt.ts` (new file)

All number rendering goes here. Commands must not format numbers inline.

```ts
// src/bot/lib/fmt.ts

/** $49,850.00 */
export function usd(n: number | string): string {
  const v = Number(n);
  if (isNaN(v)) return "$—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** $0.0421 — auto-selects decimal places */
export function price(n: number | string): string {
  const v = Number(n);
  if (isNaN(v)) return "$—";
  if (v >= 1000) return usd(v);
  if (v >= 1)    return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

/** +2.41% or -1.20% */
export function pct(n: number | string, decimals = 2): string {
  const v = Number(n);
  if (isNaN(v)) return "—%";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(decimals)}%`;
}

/** +18.24% / yr */
export function fundingApr(rateDecimal: number): string {
  // rateDecimal is the per-period rate from the API (already in decimal, e.g. 0.0001)
  // Phoenix funding settles 3× per day → 1095 periods/yr
  const apr = rateDecimal * 1095 * 100;
  return `${apr >= 0 ? "+" : ""}${apr.toFixed(2)}% / yr`;
}

/** Funding direction label */
export function fundingDir(rateDecimal: number): string {
  return rateDecimal >= 0 ? "Longs pay shorts" : "Shorts pay longs";
}

/** 0.0250 BTC */
export function cryptoSize(n: number | string, symbol: string): string {
  const v = Number(n);
  if (isNaN(v)) return `— ${symbol}`;
  return `${v.toFixed(4)} ${symbol}`;
}

/** Truncates wallet: AbC...XyZ */
export function shortAddr(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

/** Parses user input: strips $, commas, whitespace */
export function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, "");
  return parseFloat(cleaned);
}

/** Parses leverage: strips 'x', rounds to int */
export function parseLeverage(raw: string): number {
  return Math.round(parseFloat(raw.replace(/[xX]/g, "")));
}
```

---

### 0.2 Pending-state helpers — `src/bot/lib/pending.ts` (new file)

Centralise Redis pending-state with a fixed 10-minute TTL.

```ts
// src/bot/lib/pending.ts
import { redis } from "../../lib/redis.js";

const TTL = 600; // 10 minutes

export async function setPending(telegramId: number | string, value: string) {
  await redis.set(`pending:${telegramId}`, value, "EX", TTL);
}

export async function getPending(telegramId: number | string): Promise<string | null> {
  return redis.get(`pending:${telegramId}`);
}

export async function clearPending(telegramId: number | string) {
  await redis.del(`pending:${telegramId}`);
}
```

> All commands that currently call `redis.set("pending:...", ..., "EX", 120)` must be updated to call `setPending()` so TTL is consistent.

---

### 0.3 Extend `message:text` handler — `src/bot/index.ts`

The current handler only supports `addmargin`, `editsl`, `edittp`. The new guided flows add:

| PS value | What user typed | Handler |
|---|---|---|
| `addmargin:{symbol}` | amount | existing — keep |
| `editsl:{symbol}:{side}` | price | existing — keep |
| `edittp:{symbol}:{side}` | price | existing — keep |
| `withdraw_amount` | amount | NEW — goes to withdraw confirmation |
| `trade_leverage:{side}:{symbol}` | leverage integer | NEW — goes to size picker |
| `trade_size:{side}:{symbol}:{lev}` | amount | NEW — goes to confirmation |
| `pricealert:{symbol}` | price | NEW — goes to alert confirmation |

The dispatch map grows. Replace the current block in `bot/index.ts`:

```ts
// src/bot/index.ts — message:text handler (full replacement)
bot.on("message:text", async (ctx) => {
  if (!ctx.user) return;
  const pending = await getPending(ctx.from.id);
  if (!pending) return;
  await clearPending(ctx.from.id);

  const raw = ctx.message.text.trim();
  const parts = pending.split(":");
  const action = parts[0];

  // ── Withdraw: amount entry ───────────────────────────────────────────────
  if (action === "withdraw_amount") {
    const amount = parseAmount(raw);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply("That doesn't look like a valid amount. Try again with /withdraw");
      return;
    }
    // delegate to the withdraw confirmation renderer (imported function)
    await sendWithdrawConfirm(ctx, amount);
    return;
  }

  // ── Trade: custom leverage entry ─────────────────────────────────────────
  if (action === "trade_leverage") {
    const side = parts[1] as "long" | "short";
    const symbol = parts[2];
    const lev = parseLeverage(raw);
    if (isNaN(lev) || lev < 1 || lev > 100) {
      await ctx.reply("Enter a whole number between 1 and 100, e.g. 10");
      return;
    }
    await sendSizePicker(ctx, side, symbol, lev);
    return;
  }

  // ── Trade: custom size entry ──────────────────────────────────────────────
  if (action === "trade_size") {
    const side = parts[1] as "long" | "short";
    const symbol = parts[2];
    const lev = Number(parts[3]);
    const amount = parseAmount(raw);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply("Enter an amount in USD, e.g. 100");
      return;
    }
    await sendTradeConfirm(ctx, side, symbol, lev, amount);
    return;
  }

  // ── Price alert: price entry ──────────────────────────────────────────────
  if (action === "pricealert") {
    const symbol = parts[1];
    const p = parseAmount(raw);
    if (isNaN(p) || p === 0) {
      await ctx.reply("Enter a price, e.g. 52000 (or -48000 to alert when price falls below).");
      return;
    }
    await sendPriceAlertConfirm(ctx, symbol, p);
    return;
  }

  // ── Existing: add margin ──────────────────────────────────────────────────
  if (action === "addmargin") {
    const symbol = parts[1];
    const amount = parseAmount(raw);
    if (isNaN(amount) || amount <= 0) { await ctx.reply("Invalid amount."); return; }
    try {
      await addMargin(symbol, ctx.user.walletAddress, amount, getKitSigner(ctx.user.walletAddress));
      await ctx.reply(`✅ Added ${usd(amount)} margin to ${symbol}.`);
    } catch { await ctx.reply("❌ Failed. Please try again."); }
    return;
  }

  // ── Existing: edit SL ────────────────────────────────────────────────────
  if (action === "editsl") {
    const symbol = parts[1];
    const positionSide = parts[2] as "long" | "short";
    const p = parseAmount(raw);
    if (isNaN(p)) { await ctx.reply("Enter a price."); return; }
    if (p === 0) { await sendRemoveSlConfirm(ctx, symbol, positionSide); return; }
    await sendSlModePicker(ctx, symbol, positionSide, p);
    return;
  }

  // ── Existing: edit TP ────────────────────────────────────────────────────
  if (action === "edittp") {
    const symbol = parts[1];
    const positionSide = parts[2] as "long" | "short";
    const p = parseAmount(raw);
    if (isNaN(p)) { await ctx.reply("Enter a price."); return; }
    if (p === 0) { await sendRemoveTpConfirm(ctx, symbol, positionSide); return; }
    await sendTpModePicker(ctx, symbol, positionSide, p);
    return;
  }
});
```

The functions `sendWithdrawConfirm`, `sendSizePicker`, `sendTradeConfirm`, `sendPriceAlertConfirm`, `sendSlModePicker`, `sendTpModePicker`, `sendRemoveSlConfirm`, `sendRemoveTpConfirm` are defined in their respective command files and imported here.

---

### 0.4 `cancel` callback — clean up properly

Current `cancel` handler in `commands/index.ts` just edits the message to "Cancelled." Also clear pending state:

```ts
// commands/index.ts
bot.callbackQuery("cancel", async (ctx) => {
  await ctx.answerCallbackQuery("Cancelled");
  await clearPending(ctx.from.id);            // ADD THIS
  await ctx.editMessageText("✕ Cancelled.");
});
```

---

## Phase 1 — Account Overview (`/balance`)

**File:** `src/bot/commands/balance.ts`

**What changes:**
- Add navigation buttons: `[📥 Deposit]`, `[📤 Withdraw]`, `[📊 Positions]`, `[📋 History]`
- Rename "Deposited USDC" → "Deposited" (label already clear from context)
- Show "Available margin" derived from `effectiveCollateral` (the one traders actually trade against)
- Format all numbers with `usd()`
- Show short wallet address

```ts
// src/bot/commands/balance.ts (full replacement)
import type { Bot } from "grammy";
import { InlineKeyboard, Connection, PublicKey } from "...";
import { config } from "../../config/index.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { usd, shortAddr } from "../lib/fmt.js";
import type { BotContext } from "../../types/index.js";

export function registerBalance(bot: Bot<BotContext>) {
  bot.command("balance", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("You need an account first. Type /start to get set up.");
      return;
    }
    await sendBalanceScreen(ctx);
  });
}

export async function sendBalanceScreen(ctx: BotContext) {
  const [state, solLamports] = await Promise.all([
    getTraderState(ctx.user!.walletAddress),
    new Connection(config.HELIUS_RPC_URL, "confirmed")
      .getBalance(new PublicKey(ctx.user!.walletAddress))
      .catch(() => 0),
  ]);

  const sol = (solLamports / 1e9).toFixed(4);
  const deposited = Number(state.depositedCollateral);
  const effective = Number(state.effectiveCollateral);
  const upnl = Number(state.unrealizedPnl);
  const funding = Number(state.unsettledFunding);
  const totalValue = effective + upnl + funding;

  const riskEmoji: Record<string, string> = {
    safe: "🟢", healthy: "🟡", atRisk: "🟠", at_risk: "🟠",
    cancellable: "🔴", liquidatable: "🔴", backstopLiquidatable: "🔴",
  };
  const riskLabel: Record<string, string> = {
    safe: "Safe", healthy: "Healthy", atRisk: "At risk", at_risk: "At risk",
    cancellable: "Orders may cancel", liquidatable: "⚠️ Near liquidation",
    backstopLiquidatable: "⚠️ Critical",
  };
  const tier = String(state.riskTier ?? "safe");
  const tierLine = `${riskEmoji[tier] ?? "⚪"} ${riskLabel[tier] ?? tier}`;

  const kb = new InlineKeyboard()
    .text("📥 Deposit", "nav:deposit").text("📤 Withdraw", "nav:withdraw").row()
    .text("📊 Positions", "nav:positions").text("📋 History", "nav:history");

  const lines = [
    `💰 <b>Your Account</b>`,
    ``,
    `Deposited         <code>${usd(deposited)}</code>`,
    `Available margin  <code>${usd(effective)}</code>`,
    ``,
    `Unrealized P&L    <code>${usd(upnl)}</code>`,
    `Pending funding   <code>${usd(funding)}</code>`,
    ``,
    `Total value       <code>${usd(totalValue)}</code>`,
    ``,
    `Gas (SOL)  <code>${sol} SOL</code>`,
    `Wallet     <code>${shortAddr(ctx.user!.walletAddress)}</code>`,
    ``,
    tierLine,
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}
```

Add navigation callbacks in `commands/index.ts` (near the `cancel` handler):

```ts
bot.callbackQuery("nav:deposit",    (ctx) => { ctx.answerCallbackQuery(); registerDeposit_sendScreen(ctx); });
bot.callbackQuery("nav:withdraw",   (ctx) => { ctx.answerCallbackQuery(); sendWithdrawAmountPrompt(ctx); });
bot.callbackQuery("nav:positions",  (ctx) => { ctx.answerCallbackQuery(); sendPositionsScreen(ctx); });
bot.callbackQuery("nav:history",    (ctx) => { ctx.answerCallbackQuery(); sendHistoryScreen(ctx); });
```

> Each `send*Screen` function is exported from its command file (same pattern as `sendBalanceScreen` above).

---

## Phase 2 — Deposit (`/deposit`)

**File:** `src/bot/commands/deposit.ts`

**What changes:**
- Add `[← Back]` button
- Add copy-friendly address in monospace (no functional change needed — Telegram lets users long-press to copy)
- Clarify language: "USDC" not "USDC mint"

```ts
// diff — deposit.ts
- const kb = undefined; // no buttons currently
+ const kb = new InlineKeyboard().text("← Back", "nav:balance");

  await ctx.replyWithPhoto(new InputFile(qr, "deposit-qr.png"), {
    caption: [
      `📥 <b>Add Funds</b>`,
      ``,
      `Send <b>USDC</b> to your wallet:`,
      `<code>${walletAddress}</code>`,
      ``,
-     `USDC mint: <code>${WALLET_USDC_MINT}</code>`,
+     `Only send standard USDC (<code>EPjF...Dt1v</code>).`,
+     `Also send <b>≈0.01 SOL</b> to cover transaction fees.`,
      ``,
-     `Deposits are processed via Ember (1:1 wrap)...`,
+     `Funds arrive automatically — no extra steps needed.`,
    ].join("\n"),
    parse_mode: "HTML",
+   reply_markup: kb,
  });
```

---

## Phase 3 — Withdraw (`/withdraw`)

**File:** `src/bot/commands/withdraw.ts`

**What changes:**
1. `/withdraw` with no amount → prompt for amount via pending state
2. First confirm button now shows "Start 5-min timer" (clearer label)
3. Cancel button on waiting screen

```ts
// src/bot/commands/withdraw.ts — command handler (replace existing)

export function registerWithdraw(bot: Bot<BotContext>) {
  bot.command("withdraw", async (ctx) => {
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }

    const raw = ctx.match?.trim();
    if (!raw) {
      // No amount — prompt via pending state
      await sendWithdrawAmountPrompt(ctx);
      return;
    }
    const amount = parseAmount(raw);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply("Enter an amount greater than $0.");
      return;
    }
    await sendWithdrawConfirm(ctx, amount);
  });

  // ... callback handlers (see below)
}

export async function sendWithdrawAmountPrompt(ctx: BotContext) {
  const state = await getTraderState(ctx.user!.walletAddress);
  const available = Number(state.effectiveCollateral);

  await ctx.reply(
    [
      `📤 <b>Withdraw Funds</b>`,
      ``,
      `Available: <code>${usd(available)}</code>`,
      ``,
      `Reply with the amount you want to withdraw:`,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
  await setPending(ctx.from!.id, "withdraw_amount");
}

export async function sendWithdrawConfirm(ctx: BotContext, amount: number) {
  const kb = new InlineKeyboard()
    .text("✅ Start withdrawal", `withdraw:confirm:${amount}`)
    .text("✕ Cancel", "cancel");

  await ctx.reply(
    [
      `📤 <b>Withdraw ${usd(amount)}</b>`,
      ``,
      `To: <code>${shortAddr(ctx.user!.walletAddress)}</code>`,
      ``,
      `⚠️ For security, you'll need to confirm again after 5 minutes.`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}
```

Callback handler — update waiting-screen message and add cancel button:

```ts
// First confirm tap — record timestamp, show waiting screen with cancel
bot.callbackQuery(/^withdraw:confirm:([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Processing...");
  if (!ctx.user) return;
  const amount = Number(ctx.match[1]);
  const pendingKey = `withdraw:pending:${ctx.user.id}`;
  const pendingTs = await redis.get(pendingKey);

  if (!pendingTs) {
    await redis.set(pendingKey, String(Date.now()), "EX", SECURITY_DELAY_SECONDS + 60);
    const kb = new InlineKeyboard().text("✕ Cancel withdrawal", `withdraw:cancel`);
    await ctx.editMessageText(
      [
        `🔒 <b>Withdrawal pending</b>`,
        ``,
        `${usd(amount)} USDC`,
        ``,
        `Confirm again in <b>5 minutes</b> to complete.`,
        `Tap confirm again: /withdraw ${amount}`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
    return;
  }

  const elapsed = (Date.now() - Number(pendingTs)) / 1000;
  if (elapsed < SECURITY_DELAY_SECONDS) {
    const remaining = Math.ceil(SECURITY_DELAY_SECONDS - elapsed);
    await ctx.answerCallbackQuery({ text: `Wait ${remaining}s more.`, show_alert: true });
    return;
  }

  await redis.del(pendingKey);
  // execute withdrawal...
  try {
    const sig = await withdrawCollateral(
      ctx.user.walletAddress,
      BigInt(Math.round(amount * 1_000_000)),
      getKitSigner(ctx.user.walletAddress),
    );
    await ctx.editMessageText(
      [`✅ <b>Withdrawal submitted</b>`, ``, `${usd(amount)} sent to your wallet.`, ``, `Large withdrawals may take a few minutes due to on-chain queue.`].join("\n"),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    logger.error({ err }, "Withdrawal failed");
    await ctx.editMessageText("❌ Withdrawal failed. Check your balance with /balance and try again.");
  }
});

bot.callbackQuery("withdraw:cancel", async (ctx) => {
  await ctx.answerCallbackQuery("Cancelled");
  await redis.del(`withdraw:pending:${ctx.user?.id}`);
  await ctx.editMessageText("✕ Withdrawal cancelled.");
});
```

**Validation to add** (before calling `sendWithdrawConfirm`):
```ts
const state = await getTraderState(ctx.user.walletAddress);
const available = Number(state.effectiveCollateral);

if (amount > available) {
  await ctx.reply(`You only have ${usd(available)} available. Enter a smaller amount.`);
  return;
}
if (amount < 1) {
  await ctx.reply("Minimum withdrawal is $1.00.");
  return;
}
```

---

## Phase 4 — Markets (`/markets`)

**File:** `src/bot/commands/markets.ts`

**What changes:**
- Show mark price, 24h funding APR, 24h price change per market row
- Each market row becomes a button (tap → price/market info screen)
- Layout: symbol on the left, price + APR on the right

The current `getMarkets()` returns `ExchangeMarketConfig[]` — we need snapshot data (price + funding) per market. This is expensive if done per-market on load. Strategy: fetch snapshots in parallel for visible page only.

```ts
// markets.ts — updated sendMarketsPage

async function sendMarketsPage(ctx, page: number, edit: boolean) {
  const allMarkets = await getMarkets();
  const totalPages = Math.ceil(allMarkets.length / PAGE_SIZE);
  const slice = allMarkets.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Fetch snapshots in parallel for visible page only
  const snapshots = await Promise.allSettled(
    slice.map((m) => getMarketSnapshot(m.symbol))
  );

  const kb = new InlineKeyboard();
  const lines: string[] = [`📊 <b>Markets</b>  (${page + 1} / ${totalPages})`, ``];

  slice.forEach((m, i) => {
    const snap = snapshots[i].status === "fulfilled" ? snapshots[i].value : null;
    const isIsolated = ISOLATED_ONLY_MARKETS.has(m.symbol) || m.isolatedOnly;
    const isolatedTag = isIsolated ? ` <i>[ISO]</i>` : "";
    const priceStr = snap ? price(snap.markPrice) : "—";
    const aprStr   = snap ? fundingApr(snap.fundingRate) : "—";

    lines.push(`<b>${m.symbol}</b>${isolatedTag}   ${priceStr}   <i>${aprStr}</i>`);
    // Tappable button per row
    kb.text(m.symbol, `price:${m.symbol}`).row();
  });

  if (page > 0) kb.text("◀ Prev", `markets:page:${page - 1}`);
  if (page < totalPages - 1) kb.text("Next ▶", `markets:page:${page + 1}`);

  const text = lines.join("\n");
  if (edit && "editMessageText" in ctx) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}
```

> The row buttons use `price:{symbol}` CB which is already handled by the `price` command (see Phase 5). If not yet wired as a callback, add a handler in `commands/index.ts`:
> ```ts
> bot.callbackQuery(/^price:([A-Z0-9]+)$/, async (ctx) => {
>   ctx.match[1]; // symbol
>   await sendPriceScreen(ctx, ctx.match[1]);
> });
> ```

---

## Phase 5 — Market Info (`/price`)

**File:** `src/bot/commands/price.ts`

**What changes:**
- Funding shown as APR (not raw rate)
- Add funding direction label ("Longs pay" / "Shorts pay")
- Add 24h change (from `getMarketStatsHistory`)
- Fix market keyboard buttons: current `trade:long:${symbol}` already in keyboard but not handled — wire it up
- Add `[← Back]` to markets

```ts
// price.ts (full replacement)
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { getMarketSnapshot, getMarketStatsHistory, isIsolatedOnly } from "../../services/phoenix/market.js";
import { price as fmtPrice, fundingApr, fundingDir, usd } from "../lib/fmt.js";
import type { BotContext } from "../../types/index.js";

export function registerPrice(bot: Bot<BotContext>) {
  bot.command("price", async (ctx) => {
    const symbol = ctx.match?.trim().toUpperCase();
    if (!symbol) { await ctx.reply("Usage: /price SOL"); return; }
    await sendPriceScreen(ctx, symbol);
  });

  // Callback from markets list or position keyboard
  bot.callbackQuery(/^price:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPriceScreen(ctx, ctx.match[1]);
  });
}

export async function sendPriceScreen(ctx: BotContext, symbol: string) {
  let snapshot, stats;
  try {
    [snapshot, stats] = await Promise.all([
      getMarketSnapshot(symbol),
      getMarketStatsHistory(symbol, 1),
    ]);
  } catch {
    await ctx.reply(`Market "${symbol}" not found. Use /markets to browse.`);
    return;
  }

  const isolated = isIsolatedOnly(symbol);
  const oi = stats?.stats?.[0]?.open_interest;
  const oiStr = oi != null ? usd(Number(oi)) : "—";
  const apr = fundingApr(snapshot.fundingRate);
  const dir = fundingDir(snapshot.fundingRate);
  const absApr = Math.abs(snapshot.fundingRate * 1095 * 100);
  const fundingWarning = absApr > 100 ? `\n⚠️ Extreme funding rate — holding this position overnight is very expensive.` : "";

  const lines = [
    `📊 <b>${symbol}/USD</b>`,
    ``,
    `Price         <code>${fmtPrice(snapshot.markPrice)}</code>`,
    ``,
    `Funding       <code>${apr}</code>`,
    `              <i>${dir}</i>${fundingWarning}`,
    `Open interest <code>${oiStr}</code>`,
    ``,
    `Max leverage  <code>${snapshot.maxLeverage}x</code>`,
    `Taker fee     <code>${(snapshot.takerFee * 100).toFixed(2)}%</code>`,
    isolated ? `\n<i>⚠️ Isolated margin only — standard trading not available yet.</i>` : "",
  ].filter(Boolean);

  const kb = new InlineKeyboard();
  if (!isolated) {
    kb.text("🟢 Buy / Long", `trade:long:${symbol}`)
      .text("🔴 Sell / Short", `trade:short:${symbol}`)
      .row();
  }
  kb.text("🔔 Price alert", `pricealert:${symbol}`)
    .text("← Back", "markets:page:0");

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}
```

---

## Phase 6 — Open Trade (Long / Short) — Guided Flow

This is the largest change. The current one-liner `/long BTC 10x 500` becomes a guided 4-step flow. **The one-liner still works** as a power-user shortcut (command with all args provided skips to the confirmation screen).

**Files:**
- `src/bot/commands/long.ts` — full rewrite
- `src/bot/commands/short.ts` — full rewrite (symmetric)
- `src/bot/keyboards/trade.ts` — add `leveragePickerKeyboard`, `sizePickerKeyboard`

---

### 6.1 New keyboards — `src/bot/keyboards/trade.ts`

```ts
// Additions to trade.ts

/**
 * Leverage picker shown after symbol confirmed.
 * Encodes side + symbol so the callback can route correctly.
 * Highlights user's default leverage with ★.
 */
export function leveragePickerKeyboard(
  side: "long" | "short",
  symbol: string,
  maxLeverage: number,
  defaultLeverage: number,
) {
  const options = [2, 3, 5, 10, 20, 50].filter((l) => l <= maxLeverage);
  const kb = new InlineKeyboard();
  let count = 0;
  for (const l of options) {
    const label = l === defaultLeverage ? `★${l}x` : `${l}x`;
    kb.text(label, `trade_lev:${side}:${symbol}:${l}`);
    count++;
    if (count % 3 === 0) kb.row();
  }
  kb.row().text("Custom", `trade_lev_custom:${side}:${symbol}`)
         .text("✕ Cancel", "cancel");
  return kb;
}

/**
 * Size picker shown after leverage confirmed.
 * Shows dollar amounts for each percentage tier.
 */
export function sizePickerKeyboard(
  side: "long" | "short",
  symbol: string,
  lev: number,
  availableMargin: number,
) {
  const pcts = [10, 25, 50, 100];
  const kb = new InlineKeyboard();
  for (const pct of pcts) {
    const amt = (availableMargin * pct) / 100;
    const label = `${pct}%  ${usd(amt)}`;
    kb.text(label, `trade_size:${side}:${symbol}:${lev}:${amt.toFixed(2)}`).row();
  }
  kb.text("Custom amount", `trade_size_custom:${side}:${symbol}:${lev}`)
    .row().text("← Back", `trade:${side}:${symbol}`)
    .text("✕ Cancel", "cancel");
  return kb;
}
```

---

### 6.2 `long.ts` / `short.ts` — full rewrite

Both files are nearly identical (differ only in `side`, emoji, liq price formula). Show `long.ts`; `short.ts` is symmetric.

```ts
// src/bot/commands/long.ts (full rewrite)
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/index.js";
import { getMarketSnapshot, isIsolatedOnly } from "../../services/phoenix/market.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { placeMarketOrder } from "../../services/phoenix/trade.js";
import { getKitSigner } from "../../services/wallet.js";
import { subscribeUser } from "../../workers/ws.js";
import { leveragePickerKeyboard, sizePickerKeyboard, confirmKeyboard } from "../keyboards/trade.js";
import { setPending } from "../lib/pending.js";
import { usd, price as fmtPrice, fundingApr, fundingDir, parseAmount, parseLeverage } from "../lib/fmt.js";
import type { BotContext } from "../../types/index.js";
import { config } from "../../config/index.js";

export function registerLong(bot: Bot<BotContext>) {

  // ── Entry: /long ─────────────────────────────────────────────────────────
  bot.command("long", async (ctx) => {
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }

    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const symbol = parts[0]?.toUpperCase().replace("/USD", "").replace("/USDT", "");

    if (!symbol) {
      // No symbol — show popular markets picker
      await sendSymbolPicker(ctx, "long");
      return;
    }

    // Full one-liner: /long BTC 10x 500 — skip to confirmation
    if (parts.length >= 3) {
      const lev = parseLeverage(parts[1]);
      const size = parseAmount(parts[2]);
      if (isNaN(lev) || lev < 1 || isNaN(size) || size <= 0) {
        await ctx.reply("Invalid format. Example: /long BTC 10x 500\nOr just type /long BTC to use the guided flow.");
        return;
      }
      await sendTradeConfirm(ctx, "long", symbol, lev, size);
      return;
    }

    // Symbol provided, no leverage — go to leverage picker
    await sendLeveragePicker(ctx, "long", symbol);
  });

  // ── Entry: callback from market info screen ────────────────────────────
  bot.callbackQuery(/^trade:long:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }
    await sendLeveragePicker(ctx, "long", ctx.match[1]);
  });

  // ── Step 2: Leverage picked (button) ─────────────────────────────────────
  bot.callbackQuery(/^trade_lev:long:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const symbol = ctx.match[1];
    const lev = Number(ctx.match[2]);
    await sendSizePicker(ctx, "long", symbol, lev);
  });

  // ── Step 2: Leverage custom (button) ─────────────────────────────────────
  bot.callbackQuery(/^trade_lev_custom:long:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const symbol = ctx.match[1];
    await ctx.reply(`Enter your leverage for ${symbol} (1–${100}x):`);
    await setPending(ctx.from.id, `trade_leverage:long:${symbol}`);
  });

  // ── Step 3: Size picked (button) ──────────────────────────────────────────
  bot.callbackQuery(/^trade_size:long:([A-Z0-9]+):(\d+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, levStr, sizeStr] = ctx.match.slice(1);
    await sendTradeConfirm(ctx, "long", symbol, Number(levStr), Number(sizeStr));
  });

  // ── Step 3: Size custom (button) ─────────────────────────────────────────
  bot.callbackQuery(/^trade_size_custom:long:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, levStr] = ctx.match.slice(1);
    const state = await getTraderState(ctx.user.walletAddress);
    const available = Number(state.effectiveCollateral);
    await ctx.reply(`Enter the amount you want to use as margin (available: ${usd(available)}):`);
    await setPending(ctx.from.id, `trade_size:long:${symbol}:${levStr}`);
  });

  // ── Step 4: Confirm (button) ──────────────────────────────────────────────
  bot.callbackQuery(
    /^confirm:long:([A-Z0-9]+):([\d.]+):([\d.]+):([\d.]+)$/,
    async (ctx) => {
      await ctx.answerCallbackQuery("Opening trade…");
      if (!ctx.user) return;
      const [symbol, leverageStr, sizeStr, markPriceStr] = ctx.match.slice(1);
      const lev = Number(leverageStr);
      const sizeUsdc = Number(sizeStr);
      const markPrice = Number(markPriceStr);

      try {
        const sig = await placeMarketOrder(
          {
            symbol,
            side: "long",
            baseUnits: String((sizeUsdc * lev) / markPrice),
            walletAddress: ctx.user.walletAddress,
          },
          getKitSigner(ctx.user.walletAddress),
        );
        await subscribeUser(ctx.user.walletAddress, ctx.user.telegramId);

        const kb = new InlineKeyboard()
          .text("📊 View positions", "nav:positions").row()
          .text("🛑 Set stop loss", `editsl:${symbol}:long`)
          .text("🎯 Set take profit", `edittp:${symbol}:long`);

        await ctx.editMessageText(
          [
            `✅ <b>Trade opened!</b>`,
            ``,
            `🟢 ${symbol}/USD — Long ${lev}x`,
            `Position: <code>${usd(sizeUsdc * lev)}</code>`,
            `Fee paid: <code>${usd((sizeUsdc * lev * 3.5) / 10000 + (sizeUsdc * lev * config.BUILDER_FEE_BPS) / 10000)}</code>`,
            ``,
            `Tx: <code>${sig}</code>`,
          ].join("\n"),
          { parse_mode: "HTML", reply_markup: kb },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        const kb = new InlineKeyboard()
          .text("Try again", `trade:long:${symbol}`)
          .text("← Back", "nav:positions");
        await ctx.editMessageText(
          `❌ <b>Trade failed</b>\n\n${symbol} Long\nReason: <code>${msg}</code>`,
          { parse_mode: "HTML", reply_markup: kb },
        );
      }
    },
  );
}

// ── Shared helper functions (exported for message:text handler) ─────────────

export async function sendSymbolPicker(ctx: BotContext, side: "long" | "short") {
  const popular = ["BTC", "ETH", "SOL", "BNB", "AVAX"];
  const emoji = side === "long" ? "🟢" : "🔴";
  const kb = new InlineKeyboard();
  for (const s of popular) {
    kb.text(s, `trade:${side}:${s}`);
  }
  kb.row().text("Browse all markets", "markets:page:0");
  await ctx.reply(
    `${emoji} <b>${side === "long" ? "Buy / Long" : "Sell / Short"}</b>\n\nWhich market?`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function sendLeveragePicker(ctx: BotContext, side: "long" | "short", symbol: string) {
  if (isIsolatedOnly(symbol)) {
    await ctx.reply(`⚠️ <b>${symbol}</b> requires isolated margin — not available yet.\n\nUse /markets to find other markets.`, { parse_mode: "HTML" });
    return;
  }

  let snapshot;
  try {
    snapshot = await getMarketSnapshot(symbol);
  } catch {
    await ctx.reply(`Market "${symbol}" not found. Use /markets to browse.`);
    return;
  }

  const settings = (await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, ctx.user!.id),
  })) ?? { slippageBps: 50, defaultLeverage: 5 };

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Buy / Long" : "Sell / Short";
  const fundingNote = snapshot.fundingRate !== 0
    ? `Funding: <code>${fundingApr(snapshot.fundingRate)}</code>  <i>${fundingDir(snapshot.fundingRate)}</i>\n`
    : "";

  const kb = leveragePickerKeyboard(side, symbol, snapshot.maxLeverage, settings.defaultLeverage);

  await ctx.reply(
    [
      `${emoji} <b>${symbol}/USD — ${label}</b>`,
      ``,
      `Price now:  <code>${fmtPrice(snapshot.markPrice)}</code>`,
      `${fundingNote}`,
      `How much leverage?`,
      `<i>Higher leverage = bigger gains, faster liquidation.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function sendSizePicker(ctx: BotContext, side: "long" | "short", symbol: string, lev: number) {
  const [snapshot, state] = await Promise.all([
    getMarketSnapshot(symbol),
    getTraderState(ctx.user!.walletAddress),
  ]);

  const available = Number(state.effectiveCollateral);

  if (available < 10) {
    const kb = new InlineKeyboard().text("📥 Deposit", "nav:deposit");
    await ctx.reply(
      `You need at least <b>$10</b> available to open a trade.\nYou have <b>${usd(available)}</b>.\n\nDeposit funds first.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
    return;
  }

  // Validate leverage against market max
  const effectiveLev = Math.min(lev, snapshot.maxLeverage);
  const emoji = side === "long" ? "🟢" : "🔴";

  const kb = sizePickerKeyboard(side, symbol, effectiveLev, available);

  const warning = lev > snapshot.maxLeverage
    ? `\n⚠️ Leverage capped to <b>${snapshot.maxLeverage}x</b> (market max for ${symbol}).\n`
    : "";

  await ctx.reply(
    [
      `${emoji} <b>${symbol}/USD — ${side === "long" ? "Long" : "Short"} ${effectiveLev}x</b>`,
      warning,
      `Available margin:  <code>${usd(available)}</code>`,
      `Position will be:  <code>${effectiveLev}×</code> your margin`,
      ``,
      `How much margin do you want to use?`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function sendTradeConfirm(ctx: BotContext, side: "long" | "short", symbol: string, lev: number, sizeUsdc: number) {
  // Validate user has enough margin
  const [snapshot, state] = await Promise.all([
    getMarketSnapshot(symbol).catch(() => null),
    getTraderState(ctx.user!.walletAddress),
  ]);

  if (!snapshot) {
    await ctx.reply(`Market "${symbol}" not found.`);
    return;
  }

  const available = Number(state.effectiveCollateral);
  if (sizeUsdc > available) {
    await ctx.reply(`You only have <b>${usd(available)}</b> available. Enter a smaller amount.`, { parse_mode: "HTML" });
    return;
  }
  if (sizeUsdc < 10) {
    await ctx.reply("Minimum trade size is $10.");
    return;
  }

  const effectiveLev = Math.min(lev, snapshot.maxLeverage);
  const notional = sizeUsdc * effectiveLev;
  const entry = snapshot.markPrice;
  const liqPrice = side === "long"
    ? entry * (1 - 1 / effectiveLev)
    : entry * (1 + 1 / effectiveLev);
  const liqPct = (100 / effectiveLev).toFixed(0);

  const totalFee = (notional * (3.5 + config.BUILDER_FEE_BPS)) / 10000;
  const totalCost = sizeUsdc + totalFee;

  const absApr = Math.abs(snapshot.fundingRate * 1095 * 100);
  const fundingPerDay = (notional * Math.abs(snapshot.fundingRate) * 3).toFixed(2); // 3 settlements/day
  const fundingNote = absApr > 10
    ? `\n⚠️ Funding: <code>${fundingApr(snapshot.fundingRate)}</code> — you pay ≈<code>$${fundingPerDay}</code>/day on this position.`
    : "";

  const emoji = side === "long" ? "🟢" : "🔴";
  const dirWord = side === "long" ? "drops to" : "rises to";

  const kb = new InlineKeyboard()
    .text("✅ Open trade", `confirm:${side}:${symbol}:${effectiveLev}:${sizeUsdc}:${entry.toFixed(4)}`)
    .text("✕ Cancel", "cancel");

  await ctx.reply(
    [
      `📋 <b>Review your trade</b>`,
      ``,
      `${emoji} ${symbol}/USD — ${side === "long" ? "Long" : "Short"} ${effectiveLev}x`,
      ``,
      `Position size   <code>${usd(notional)}</code>`,
      `Your margin     <code>${usd(sizeUsdc)}</code>`,
      `Entry price     <code>~${fmtPrice(entry)}</code>`,
      `Fee             <code>${usd(totalFee)}</code>`,
      `You pay total   <code>${usd(totalCost)}</code>`,
      ``,
      `Liquidated if price ${dirWord}: <code>${fmtPrice(liqPrice)}</code>  <i>(-${liqPct}%)</i>`,
      fundingNote,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}
```

> **`short.ts`** is identical except:
> - All `"long"` literals → `"short"`
> - Emoji `🟢` → `🔴`
> - Label `"Buy / Long"` → `"Sell / Short"`
> - Liq price formula: `entry * (1 + 1 / effectiveLev)` instead of `entry * (1 - 1 / effectiveLev)`
> - `dirWord` = `"rises to"` instead of `"drops to"`

---

## Phase 7 — Open Positions (`/positions`)

**File:** `src/bot/commands/positions.ts`

**What changes:**
- Richer position card (shows TP/SL status, better PnL formatting)
- Add close confirmation step (currently closes immediately on tap)
- Add margin flow shows available balance and previews liq price change

### 7.1 Position card

```ts
// positions.ts — updated card per position

for (const pos of positions) {
  const upnl = Number(pos.unrealizedPnl);
  const pnlSign = upnl >= 0 ? "+" : "";
  const emoji = pos.side === "long" ? "🟢" : "🔴";
  const sideLabel = pos.side === "long" ? "Long" : "Short";

  // Derive leverage from entry/liq if possible (approximate)
  // pos.size in base units, pos.entryPrice, pos.unrealizedPnl
  const posNotional = Number(pos.size) * Number(pos.entryPrice);
  const liqLabel = pos.liquidationPrice === "N/A"
    ? "None (safe)"
    : fmtPrice(Number(pos.liquidationPrice));

  const lines = [
    `${emoji} <b>${pos.symbol}/USD — ${sideLabel}</b>`,
    ``,
    `Size         <code>${Number(pos.size).toFixed(4)} ${pos.symbol}  (${usd(posNotional)})</code>`,
    `Entry price  <code>${fmtPrice(Number(pos.entryPrice))}</code>`,
    `Mark price   <code>${fmtPrice(Number(pos.markPrice))}</code>`,
    ``,
    `P&L          <code>${pnlSign}${usd(upnl)}</code>`,
    ``,
    `Liquidation  <code>${liqLabel}</code>`,
  ];

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: positionKeyboard(pos.symbol, pos.side),
  });
}
```

### 7.2 Updated position keyboard

```ts
// keyboards/position.ts (full replacement)
import { InlineKeyboard } from "grammy";

export function positionKeyboard(symbol: string, side: "long" | "short") {
  return new InlineKeyboard()
    .text("Close 25%",  `close:${symbol}:25`)
    .text("Close 50%",  `close:${symbol}:50`).row()
    .text("Close 75%",  `close:${symbol}:75`)
    .text("Close all",  `close:${symbol}:100`).row()
    .text("Add margin", `margin:${symbol}`)
    .text("Edit SL",    `editsl:${symbol}:${side}`)  // encode side directly
    .text("Edit TP",    `edittp:${symbol}:${side}`);
}
```

> Note: `editsl` and `edittp` callbacks now include side directly, eliminating the extra `getTraderState()` call in the callback handler.

### 7.3 Close confirmation step

Currently closes immediately. Add a confirm screen:

```ts
// positions.ts — close callback (replace existing ^close: handler)

bot.callbackQuery(/^close:([A-Z0-9]+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const symbol = ctx.match[1];
  const percent = Number(ctx.match[2]);

  // Fetch current position for confirmation message
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol);
  if (!pos) {
    await ctx.editMessageText(`⚠️ No open ${symbol} position found. It may have already been closed.`);
    return;
  }

  const fraction = percent / 100;
  const notional = Number(pos.size) * Number(pos.entryPrice);
  const closeNotional = notional * fraction;
  const closePnl = Number(pos.unrealizedPnl) * fraction;
  const pnlSign = closePnl >= 0 ? "+" : "";
  const feeEst = closeNotional * 3.5 / 10000;
  const closeLabel = percent === 100 ? "Close all" : `Close ${percent}%`;

  const kb = new InlineKeyboard()
    .text("✅ Confirm close", `close:exec:${symbol}:${percent}`)
    .text("✕ Cancel", "cancel");

  await ctx.editMessageText(
    [
      `Close ${percent === 100 ? "all of" : `${percent}% of`} <b>${symbol} ${pos.side}</b>?`,
      ``,
      `Closing:   <code>~${usd(closeNotional)}</code>`,
      `At price:  <code>~${fmtPrice(Number(pos.markPrice))}</code>`,
      `Est. fee:  <code>${usd(feeEst)}</code>`,
      ``,
      `P&L on this portion: <code>${pnlSign}${usd(closePnl)}</code>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
});

// Execution after confirm
bot.callbackQuery(/^close:exec:([A-Z0-9]+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Closing…");
  if (!ctx.user) return;
  const symbol = ctx.match[1];
  const fraction = Number(ctx.match[2]) / 100;

  try {
    const sig = await closePosition(symbol, ctx.user.walletAddress, getKitSigner(ctx.user.walletAddress), fraction);
    const kb = new InlineKeyboard()
      .text("📊 Positions", "nav:positions")
      .text("📋 History", "nav:history");
    await ctx.editMessageText(
      [`✅ <b>Position closed</b>`, ``, `${symbol}`, `Tx: <code>${sig}</code>`].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const kb = new InlineKeyboard().text("Try again", `close:${symbol}:${Math.round(fraction * 100)}`);
    await ctx.editMessageText(
      `❌ Couldn't close position.\nReason: <code>${msg}</code>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  }
});
```

### 7.4 Add margin flow — show available balance and liq preview

```ts
// positions.ts — margin callback (replace existing ^margin: handler)

bot.callbackQuery(/^margin:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const symbol = ctx.match[1];

  const state = await getTraderState(ctx.user.walletAddress);
  const available = Number(state.effectiveCollateral);
  const pos = state.positions.find((p) => p.symbol === symbol);

  if (!pos) {
    await ctx.reply(`No open ${symbol} position found.`);
    return;
  }

  if (available <= 0) {
    const kb = new InlineKeyboard().text("📥 Deposit", "nav:deposit");
    await ctx.reply(
      `You have no free margin available (<code>${usd(available)}</code>).\n\nDeposit more USDC first.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
    return;
  }

  const liqLabel = pos.liquidationPrice === "N/A" ? "None" : fmtPrice(Number(pos.liquidationPrice));

  await ctx.reply(
    [
      `<b>Add Margin — ${symbol}</b>`,
      ``,
      `Current liquidation price: <code>${liqLabel}</code>`,
      `Available to add:          <code>${usd(available)}</code>`,
      ``,
      `Reply with the amount to add:`,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
  await setPending(ctx.from.id, `addmargin:${symbol}`);
});
```

Add margin confirmation in the `message:text` handler (Phase 0.3):

```ts
// In the addmargin branch of message:text handler — add confirm screen
if (action === "addmargin") {
  const symbol = parts[1];
  const amount = parseAmount(raw);
  if (isNaN(amount) || amount <= 0) { await ctx.reply("Invalid amount."); return; }

  const state = await getTraderState(ctx.user.walletAddress);
  const available = Number(state.effectiveCollateral);
  if (amount > available) {
    await ctx.reply(`You only have ${usd(available)} available.`);
    return;
  }

  const kb = new InlineKeyboard()
    .text("✅ Add margin", `addmargin:exec:${symbol}:${amount}`)
    .text("✕ Cancel", "cancel");

  await ctx.reply(
    [`Add <b>${usd(amount)}</b> margin to ${symbol}?`, ``, `Available after: <code>${usd(available - amount)}</code>`].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}
```

Add execution callback in `positions.ts`:

```ts
bot.callbackQuery(/^addmargin:exec:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Adding margin…");
  if (!ctx.user) return;
  const [symbol, amountStr] = ctx.match.slice(1);
  try {
    await addMargin(symbol, ctx.user.walletAddress, Number(amountStr), getKitSigner(ctx.user.walletAddress));
    await ctx.editMessageText(`✅ Added ${usd(Number(amountStr))} margin to ${symbol}.`);
  } catch {
    await ctx.editMessageText("❌ Failed to add margin. Try again.");
  }
});
```

---

## Phase 8 — Stop Loss / Take Profit

**Files:** `src/bot/commands/setsl.ts`, `src/bot/commands/settp.ts`

**What changes:**
1. `editsl:{symbol}:{side}` callback (from position keyboard) no longer re-fetches position — side already encoded
2. Price entry via pending state (already works); add validation for correct direction + liq price floor
3. Mode selection screen after price entered
4. `0` removes existing SL/TP
5. Standalone `/setsl` and `/settp` commands get guided prompt flow

### 8.1 Callback handlers for `editsl` / `edittp` from position keyboard

```ts
// positions.ts — replace existing editsl/edittp callback handlers

bot.callbackQuery(/^editsl:([A-Z0-9]+):(long|short)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
  await sendSlPrompt(ctx, symbol, side);
});

bot.callbackQuery(/^edittp:([A-Z0-9]+):(long|short)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
  await sendTpPrompt(ctx, symbol, side);
});
```

### 8.2 `setsl.ts` — guided flow functions

```ts
// src/bot/commands/setsl.ts (full rewrite)

export async function sendSlPrompt(ctx: BotContext, symbol: string, positionSide: "long" | "short") {
  const state = await getTraderState(ctx.user!.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol);
  if (!pos) {
    await ctx.reply(`No open ${symbol} position found.`);
    return;
  }

  const liqLabel = pos.liquidationPrice === "N/A" ? "None" : fmtPrice(Number(pos.liquidationPrice));
  const direction = positionSide === "long" ? "below the current price" : "above the current price";

  await ctx.reply(
    [
      `🛑 <b>Set Stop Loss — ${symbol}</b>`,
      ``,
      `Current price:  <code>${fmtPrice(Number(pos.markPrice))}</code>`,
      `Liquidation at: <code>${liqLabel}</code>`,
      ``,
      `Enter the price to trigger your stop loss.`,
      `(Must be ${direction}.)`,
      ``,
      `Send <b>0</b> to remove your current stop loss.`,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
  await setPending(ctx.from!.id, `editsl:${symbol}:${positionSide}`);
}

// Called from message:text handler after user replies with a price
export async function sendSlModePicker(ctx: BotContext, symbol: string, positionSide: "long" | "short", triggerPrice: number) {
  // Validate direction
  const state = await getTraderState(ctx.user!.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol);
  if (!pos) { await ctx.reply(`No open ${symbol} position found.`); return; }

  const markPrice = Number(pos.markPrice);
  const liqPrice = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);

  if (positionSide === "long") {
    if (triggerPrice >= markPrice) {
      await ctx.reply(`Stop loss must be below the current price (${fmtPrice(markPrice)}). Enter a lower price.`);
      return;
    }
    if (liqPrice > 0 && triggerPrice <= liqPrice) {
      await ctx.reply(`That price is at or below your liquidation price (${fmtPrice(liqPrice)}). Enter a higher price.`);
      return;
    }
  } else {
    if (triggerPrice <= markPrice) {
      await ctx.reply(`Stop loss must be above the current price (${fmtPrice(markPrice)}). Enter a higher price.`);
      return;
    }
  }

  // Proximity warning: within 0.5% of current price
  const proximity = Math.abs(triggerPrice - markPrice) / markPrice;
  const proximityWarn = proximity < 0.005
    ? `\n⚠️ That stop is very close to the current price and could trigger immediately.`
    : "";

  const estimatedLoss = Math.abs(triggerPrice - Number(pos.entryPrice)) * Number(pos.size);
  const kb = new InlineKeyboard()
    .text("Market (recommended)", `sl:mode:${symbol}:${triggerPrice}:market:${positionSide}`).row()
    .text("Limit", `sl:mode:${symbol}:${triggerPrice}:limit:${positionSide}`).row()
    .text("✕ Cancel", "cancel");

  await ctx.reply(
    [
      `Stop loss at <b>${fmtPrice(triggerPrice)}</b>${proximityWarn}`,
      ``,
      `<b>Market</b> — Close immediately at best available price`,
      `           (may fill slightly past ${fmtPrice(triggerPrice)})`,
      ``,
      `<b>Limit</b>  — Place a sell order at exactly ${fmtPrice(triggerPrice)}`,
      `           (may not fill if price moves through quickly)`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function sendRemoveSlConfirm(ctx: BotContext, symbol: string, positionSide: "long" | "short") {
  const kb = new InlineKeyboard()
    .text("✅ Remove stop loss", `sl:remove:${symbol}:${positionSide}`)
    .text("✕ Cancel", "cancel");
  await ctx.reply(`Remove stop loss for <b>${symbol}</b>?`, { parse_mode: "HTML", reply_markup: kb });
}

// Callbacks in setsl.ts
export function registerSetSl(bot: Bot<BotContext>) {

  // Command entry
  bot.command("setsl", async (ctx) => {
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    if (!parts[0]) {
      await ctx.reply("Usage: /setsl <symbol> <price> [market|limit]\nExample: /setsl BTC 45000");
      return;
    }
    const symbol = parts[0].toUpperCase();
    // Quick path if all args provided
    if (parts.length >= 2) {
      const p = parseAmount(parts[1]);
      if (isNaN(p)) { await ctx.reply("Invalid price."); return; }
      const mode = parts[2] === "limit" ? "limit" : "market";
      const state = await getTraderState(ctx.user.walletAddress);
      const pos = state.positions.find((pp) => pp.symbol === symbol);
      if (!pos) { await ctx.reply(`No open ${symbol} position.`); return; }
      // Skip mode picker, go straight to confirm
      await sendSlFinalConfirm(ctx, symbol, p, mode, pos.side);
      return;
    }
    // Guided path: need price from user
    const state = await getTraderState(ctx.user.walletAddress);
    const pos = state.positions.find((pp) => pp.symbol === symbol);
    if (!pos) { await ctx.reply(`No open ${symbol} position.`); return; }
    await sendSlPrompt(ctx, symbol, pos.side);
  });

  // Mode picker callback → final confirm
  bot.callbackQuery(/^sl:mode:([A-Z0-9]+):([\d.]+):(market|limit):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, priceStr, mode, side] = ctx.match.slice(1) as [string, string, "market" | "limit", "long" | "short"];
    await sendSlFinalConfirm(ctx, symbol, Number(priceStr), mode, side);
  });

  // Remove SL callback
  bot.callbackQuery(/^sl:remove:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Removing…");
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    try {
      await cancelStopLoss(symbol, ctx.user.walletAddress, side === "long" ? "long_sl" : "short_sl", getKitSigner(ctx.user.walletAddress));
      await ctx.editMessageText(`✅ Stop loss removed for ${symbol}.`);
    } catch {
      await ctx.editMessageText("❌ Failed to remove stop loss.");
    }
  });

  // Final confirm → execute
  bot.callbackQuery(/^sl:exec:([A-Z0-9]+):([\d.]+):(market|limit):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Setting…");
    if (!ctx.user) return;
    const [symbol, priceStr, mode, side] = ctx.match.slice(1) as [string, string, "market" | "limit", "long" | "short"];
    try {
      await setTpSl(
        { symbol, walletAddress: ctx.user.walletAddress, positionSide: side, slPrice: Number(priceStr), slMode: mode },
        getKitSigner(ctx.user.walletAddress),
      );
      await ctx.editMessageText(
        [`✅ <b>Stop loss set</b>`, ``, `${symbol} — ${fmtPrice(Number(priceStr))}`, `You'll be notified when it triggers.`].join("\n"),
        { parse_mode: "HTML" },
      );
    } catch {
      await ctx.editMessageText("❌ Failed to set stop loss.");
    }
  });
}

async function sendSlFinalConfirm(ctx: BotContext, symbol: string, triggerPrice: number, mode: "market" | "limit", positionSide: "long" | "short") {
  const state = await getTraderState(ctx.user!.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol);
  const fromEntry = pos ? Math.abs(Number(pos.entryPrice) - triggerPrice) * Number(pos.size) : null;
  const lossStr = fromEntry !== null ? `\nMax loss from entry: <code>-${usd(fromEntry)}</code>` : "";

  const kb = new InlineKeyboard()
    .text("✅ Set stop loss", `sl:exec:${symbol}:${triggerPrice}:${mode}:${positionSide}`)
    .text("✕ Cancel", "cancel");

  await ctx.reply(
    [
      `Set stop loss?`,
      ``,
      `<b>${symbol}</b> — ${fmtPrice(triggerPrice)} (${mode === "market" ? "Market" : "Limit"})`,
      lossStr,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}
```

> **`settp.ts`** follows exactly the same pattern: `sendTpPrompt`, `sendTpModePicker`, `sendRemoveTpConfirm`, `sendTpFinalConfirm`. Direction validation is reversed (long TP must be above mark price; short TP must be below).

---

## Phase 9 — Trade History (`/history`)

**File:** `src/bot/commands/history.ts`

**What changes:**
- Better layout: symbol + side on one line, price + PnL on next
- Green/red PnL with sign
- "More trades exist" with count if `hasMore`

```ts
// history.ts (full replacement)

export function registerHistory(bot: Bot<BotContext>) {
  bot.command("history", async (ctx) => {
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }
    await sendHistoryScreen(ctx);
  });
}

export async function sendHistoryScreen(ctx: BotContext) {
  const history = await getTradeHistory(ctx.user!.walletAddress, 20);

  if (history.trades.length === 0) {
    const kb = new InlineKeyboard().text("Browse markets", "markets:page:0");
    await ctx.reply("No closed trades yet.\n\nReady to make your first trade?", { reply_markup: kb });
    return;
  }

  const lines = history.trades.map((t) => {
    const pnl = Number(t.realizedPnl ?? 0);
    const pnlStr = pnl >= 0 ? `+${usd(pnl)}` : usd(pnl);
    const emoji = t.side === "long" ? "🟢" : "🔴";
    const d = new Date(t.timestamp);
    const dateStr = `${d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    return `${emoji} <b>${t.symbol}</b>  ${fmtPrice(Number(t.price))}  <code>${pnlStr}</code>  <i>${dateStr}</i>`;
  });

  const footer = history.hasMore ? `\n<i>Showing 20 most recent.</i>` : "";
  const kb = new InlineKeyboard().text("← Account", "nav:balance");

  await ctx.reply(
    [`📋 <b>Trade History</b>`, ``, ...lines, footer].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}
```

---

## Phase 10 — PnL (`/pnl`)

**File:** `src/bot/commands/pnl.ts`

Minor update — add buttons and better formatting:

```ts
export async function registerPnl(bot: Bot<BotContext>) {
  bot.command("pnl", async (ctx) => {
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }
    const state = await getTraderState(ctx.user.walletAddress);

    const upnl = Number(state.unrealizedPnl);
    const funding = Number(state.unsettledFunding);
    const sign = (n: number) => (n >= 0 ? "+" : "");

    const kb = new InlineKeyboard()
      .text("📊 Positions", "nav:positions")
      .text("📋 History",   "nav:history");

    await ctx.reply(
      [
        `📊 <b>P&L Summary</b>`,
        ``,
        `Unrealized P&L   <code>${sign(upnl)}${usd(upnl)}</code>`,
        `Pending funding  <code>${sign(funding)}${usd(funding)}</code>`,
        ``,
        `<i>For closed trade P&L see /history.</i>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });
}
```

---

## Phase 11 — Settings (`/settings`)

**File:** `src/bot/commands/settings.ts`

**What changes:**
- Show current selection highlighted in panel (not just as button label)
- After saving, re-render full panel (not just "✅ set to X")
- Show current values inline

```ts
// settings.ts — showSettings with current values highlighted

async function showSettings(ctx: BotContext) {
  const settings = (await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, ctx.user!.id),
  })) ?? { slippageBps: 50, defaultLeverage: 5 };

  const slipPct = settings.slippageBps / 100;
  const lev = settings.defaultLeverage;

  // Slippage row
  const slipOptions = [10, 30, 50, 100, 200];
  const slipKb = new InlineKeyboard();
  for (const bps of slipOptions) {
    const label = bps === settings.slippageBps ? `★${bps / 100}%` : `${bps / 100}%`;
    slipKb.text(label, `slip:${bps}`);
  }

  // Leverage row
  const levOptions = [2, 5, 10, 25];
  const levKb = new InlineKeyboard();
  for (const l of levOptions) {
    const label = l === lev ? `★${l}x` : `${l}x`;
    levKb.text(label, `lev:${l}`);
  }

  const kb = new InlineKeyboard();
  for (const bps of slipOptions) {
    kb.text(bps === settings.slippageBps ? `★${bps / 100}%` : `${bps / 100}%`, `slip:${bps}`);
  }
  kb.row();
  for (const l of levOptions) {
    kb.text(l === lev ? `★${l}x` : `${l}x`, `lev:${l}`);
  }
  kb.row().text("🔔 Manage alerts →", "settings:alerts");

  await ctx.reply(
    [
      `⚙️ <b>Settings</b>`,
      ``,
      `Slippage tolerance   <code>${slipPct}%</code>`,
      `Default leverage     <code>${lev}x</code>`,
      ``,
      `<i>★ = current selection</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

// After saving, re-render the settings panel instead of "✅ set to X"
bot.callbackQuery(/^slip:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Saved");
  if (!ctx.user) return;
  const bps = Number(ctx.match[1]);
  await db.insert(userSettings).values({ userId: ctx.user.id, slippageBps: bps })
    .onConflictDoUpdate({ target: userSettings.userId, set: { slippageBps: bps, updatedAt: new Date() } });
  // Re-render settings panel in-place
  await ctx.editMessageText("..."); // re-call showSettings logic inline
});
```

---

## Phase 12 — Price Alerts (`/alert`)

**File:** `src/bot/commands/pricealert.ts`

**What changes:**
- From `[🔔 Price alert]` button on market info screen → guided flow via pending state
- Show confirmation before inserting
- Validate: not same as current price, not duplicate

```ts
// pricealert.ts (full replacement)

export function registerPriceAlert(bot: Bot<BotContext>) {

  // Command entry: /alert SOL 200
  bot.command("alert", async (ctx) => {
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    if (parts.length < 1 || !parts[0]) {
      await ctx.reply("Usage: /alert <symbol> <price>\nExample: /alert BTC 52000\nUse a minus for ≤: /alert BTC -48000");
      return;
    }
    const symbol = parts[0].toUpperCase();
    if (parts.length < 2) {
      // Guided: just symbol provided → prompt for price
      await sendPriceAlertPrompt(ctx, symbol);
      return;
    }
    const p = parseAmount(parts[1]);
    if (isNaN(p) || p === 0) { await ctx.reply("Enter a price."); return; }
    await sendPriceAlertConfirm(ctx, symbol, p);
  });

  // Callback from price screen button
  bot.callbackQuery(/^pricealert:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }
    await sendPriceAlertPrompt(ctx, ctx.match[1]);
  });

  // Final confirm callback
  bot.callbackQuery(/^pricealert:exec:([A-Z0-9]+):(-?[\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, priceStr] = ctx.match.slice(1);
    const p = Number(priceStr);

    await db.insert(alertSubscriptions).values({
      id: crypto.randomUUID(),
      userId: ctx.user.id,
      type: "price",
      symbol,
      triggerPrice: String(p),
      enabled: true,
    });

    const direction = p > 0 ? `≥ ${fmtPrice(p)}` : `≤ ${fmtPrice(Math.abs(p))}`;
    await ctx.editMessageText(
      [`🔔 <b>Alert set</b>`, ``, `${symbol} → ${direction}`, ``, `We'll message you when the price crosses this level.`].join("\n"),
      { parse_mode: "HTML" },
    );
  });
}

async function sendPriceAlertPrompt(ctx: BotContext, symbol: string) {
  let snapshot;
  try { snapshot = await getMarketSnapshot(symbol); } catch { /* ignore */ }

  const currentStr = snapshot ? `Current price: <code>${fmtPrice(snapshot.markPrice)}</code>\n` : "";

  await ctx.reply(
    [
      `🔔 <b>Price Alert — ${symbol}</b>`,
      ``,
      currentStr,
      `Reply with the target price.`,
      `Add <b>−</b> to alert when price falls below: <code>-48000</code>`,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
  await setPending(ctx.from!.id, `pricealert:${symbol}`);
}

export async function sendPriceAlertConfirm(ctx: BotContext, symbol: string, p: number) {
  // Fetch current price for validation
  const snapshot = await getMarketSnapshot(symbol).catch(() => null);
  if (snapshot) {
    const mark = snapshot.markPrice;
    if (p > 0 && p <= mark) {
      await ctx.reply(`That price (${fmtPrice(p)}) is at or below the current price (${fmtPrice(mark)}). Use a positive price above the current price, or a negative price to alert on the way down.`);
      return;
    }
    if (p < 0 && Math.abs(p) >= mark) {
      await ctx.reply(`That price (${fmtPrice(Math.abs(p))}) is at or above the current price (${fmtPrice(mark)}). Use a negative price below the current price.`);
      return;
    }
  }

  const direction = p > 0 ? `reaches ${fmtPrice(p)} ↑` : `falls to ${fmtPrice(Math.abs(p))} ↓`;
  const kb = new InlineKeyboard()
    .text("✅ Set alert", `pricealert:exec:${symbol}:${p}`)
    .text("✕ Cancel", "cancel");

  await ctx.reply(
    [`Set price alert?`, ``, `<b>${symbol}</b> when it ${direction}`].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}
```

---

## Phase 13 — Alerts Management (`/alerts`)

**File:** `src/bot/commands/alerts.ts`

**What changes:**
- Better human labels (no jargon)

```ts
// alerts.ts — replace DEFAULT_ALERTS with friendlier labels

const DEFAULT_ALERTS = [
  { type: "at_risk",       label: "Margin at risk",           default: true  },
  { type: "cancellable",   label: "Orders may cancel",        default: true  },
  { type: "liquidatable",  label: "Near liquidation",         default: true  },
  { type: "fill",          label: "Order filled",             default: true  },
  { type: "tpsl_flip",     label: "Position flipped",         default: true  },
  { type: "funding_flip",  label: "Funding rate flipped",     default: false },
  { type: "large_funding", label: "Extreme funding (>50%)",   default: false },
] as const;
```

Also fix the existing bug: `buildAlertsKeyboard` already uses `eq(alertSubscriptions.type, type)` correctly in the current code (no bug in this version) — but add a guard just in case:

```ts
// In buildAlertsKeyboard — ensure type filter is present
const sub = subs.find((s) => s.type === a.type && s.symbol === null);
```

---

## Callback Data Registry (complete reference)

| Callback | Defined in | Description |
|---|---|---|
| `nav:balance` | index.ts | Go to balance screen |
| `nav:deposit` | index.ts | Go to deposit screen |
| `nav:withdraw` | index.ts | Go to withdraw amount prompt |
| `nav:positions` | index.ts | Go to positions screen |
| `nav:history` | index.ts | Go to history screen |
| `markets:page:N` | markets.ts | Paginate markets |
| `price:SYMBOL` | price.ts | Market info screen |
| `trade:long:SYMBOL` | long.ts | Start long guided flow |
| `trade:short:SYMBOL` | short.ts | Start short guided flow |
| `trade_lev:SIDE:SYMBOL:LEV` | long/short.ts | Leverage picked |
| `trade_lev_custom:SIDE:SYMBOL` | long/short.ts | Custom leverage prompt |
| `trade_size:SIDE:SYMBOL:LEV:AMT` | long/short.ts | Size picked |
| `trade_size_custom:SIDE:SYMBOL:LEV` | long/short.ts | Custom size prompt |
| `confirm:SIDE:SYMBOL:LEV:SIZE:PRICE` | long/short.ts | Execute trade |
| `close:SYMBOL:PCT` | positions.ts | Close confirmation screen |
| `close:exec:SYMBOL:PCT` | positions.ts | Execute close |
| `margin:SYMBOL` | positions.ts | Add margin prompt |
| `addmargin:exec:SYMBOL:AMT` | positions.ts | Execute add margin |
| `editsl:SYMBOL:SIDE` | positions.ts | SL price prompt |
| `edittp:SYMBOL:SIDE` | positions.ts | TP price prompt |
| `sl:mode:SYMBOL:PRICE:MODE:SIDE` | setsl.ts | SL mode selection |
| `sl:exec:SYMBOL:PRICE:MODE:SIDE` | setsl.ts | Execute set SL |
| `sl:remove:SYMBOL:SIDE` | setsl.ts | Remove SL |
| `tp:mode:SYMBOL:PRICE:MODE:SIDE` | settp.ts | TP mode selection |
| `tp:exec:SYMBOL:PRICE:MODE:SIDE` | settp.ts | Execute set TP |
| `tp:remove:SYMBOL:SIDE` | settp.ts | Remove TP |
| `withdraw:confirm:AMT` | withdraw.ts | Start 5-min timer |
| `withdraw:cancel` | withdraw.ts | Cancel pending withdrawal |
| `pricealert:SYMBOL` | pricealert.ts | Price alert prompt |
| `pricealert:exec:SYMBOL:PRICE` | pricealert.ts | Save alert |
| `alert:toggle:TYPE` | alerts.ts | Toggle alert on/off |
| `slip:BPS` | settings.ts | Save slippage |
| `lev:N` | settings.ts | Save default leverage |
| `settings:alerts` | settings.ts | Go to alerts |
| `cancel` | index.ts | Cancel + clear pending |

---

## Pending State Registry (complete reference)

All keys use `setPending(telegramId, value)` with 10-minute TTL.

| Value | Set in | Dispatched by | Expected reply |
|---|---|---|---|
| `withdraw_amount` | withdraw.ts | message:text | USD amount |
| `trade_leverage:SIDE:SYMBOL` | long/short.ts | message:text | Integer |
| `trade_size:SIDE:SYMBOL:LEV` | long/short.ts | message:text | USD amount |
| `pricealert:SYMBOL` | pricealert.ts | message:text | Price (positive or negative) |
| `addmargin:SYMBOL` | positions.ts | message:text | USD amount |
| `editsl:SYMBOL:SIDE` | positions/setsl.ts | message:text | Price (or 0 to remove) |
| `edittp:SYMBOL:SIDE` | positions/settp.ts | message:text | Price (or 0 to remove) |

---

## Known Bugs Fixed by This Plan

| Bug | Fix in |
|---|---|
| `deposit.ts` + `share.ts` — `Uint8Array` not wrapped in `InputFile` | Phase 2 (deposit.ts now uses `new InputFile(qr, ...)` — already fixed in current code; verify share.ts) |
| `referral.ts` — T2 lookup missing tier filter | Out of scope for this plan (not a UX flow) |
| `ws` / `@types/ws` not in package.json | Out of scope |
| `editsl` / `edittp` callbacks — no side encoded, re-fetches position | Fixed in Phase 7.2 (position keyboard now encodes side) |
| Pending state TTL is 120s (too short) | Fixed in Phase 0.2 (10-minute TTL via `setPending`) |
| No cancel for withdrawal mid-flow | Fixed in Phase 3 |
| `close` executes immediately without confirmation | Fixed in Phase 7.3 |

---

## File Creation / Modification Summary

| Action | File |
|---|---|
| **Create** | `src/bot/lib/fmt.ts` |
| **Create** | `src/bot/lib/pending.ts` |
| **Modify** | `src/bot/index.ts` — extend message:text, add nav callbacks |
| **Modify** | `src/bot/commands/index.ts` — add nav callbacks, price callback |
| **Modify** | `src/bot/commands/balance.ts` — add buttons, better layout |
| **Modify** | `src/bot/commands/deposit.ts` — add back button, clean copy |
| **Modify** | `src/bot/commands/withdraw.ts` — amount prompt, cancel button |
| **Rewrite** | `src/bot/commands/long.ts` — full guided flow |
| **Rewrite** | `src/bot/commands/short.ts` — full guided flow (symmetric) |
| **Rewrite** | `src/bot/commands/positions.ts` — better cards, close confirm, margin preview |
| **Rewrite** | `src/bot/commands/setsl.ts` — guided flow, validation |
| **Rewrite** | `src/bot/commands/settp.ts` — guided flow, validation |
| **Rewrite** | `src/bot/commands/markets.ts` — price/funding per row, tappable rows |
| **Rewrite** | `src/bot/commands/price.ts` — APR display, back button |
| **Rewrite** | `src/bot/commands/history.ts` — better layout |
| **Modify** | `src/bot/commands/pnl.ts` — add navigation buttons |
| **Modify** | `src/bot/commands/settings.ts` — highlight current, re-render on save |
| **Rewrite** | `src/bot/commands/pricealert.ts` — guided flow from button |
| **Modify** | `src/bot/commands/alerts.ts` — friendlier labels |
| **Modify** | `src/bot/keyboards/trade.ts` — add leveragePickerKeyboard, sizePickerKeyboard |
| **Modify** | `src/bot/keyboards/position.ts` — encode side in SL/TP buttons |
| **Modify** | `src/bot/keyboards/market.ts` — update button labels |

---

## TODO

Work top-to-bottom. Each phase depends on the previous one being complete.
Mark each item `[x]` when done.

---

### Phase 0 — Shared Infrastructure

**0.1 — `src/bot/lib/fmt.ts`**
- [x] Create `src/bot/lib/` directory
- [x] Implement `usd(n)` — `$X,XXX.XX` using `toLocaleString`
- [x] Implement `price(n)` — auto-precision: 2 dp for ≥$1, 4 dp for ≥$0.01, 6 dp for smaller
- [x] Implement `pct(n, decimals)` — signed percentage string
- [x] Implement `fundingApr(rateDecimal)` — multiply by 1095 × 100 for APR
- [x] Implement `fundingDir(rateDecimal)` — "Longs pay shorts" / "Shorts pay longs"
- [x] Implement `cryptoSize(n, symbol)` — 4 decimal places
- [x] Implement `shortAddr(addr)` — `AbC...XyZ` (first 4, last 4 chars)
- [x] Implement `parseAmount(raw)` — strips `$`, `,`, whitespace; returns `parseFloat`
- [x] Implement `parseLeverage(raw)` — strips `x`/`X`, `Math.round(parseFloat(...))`

**0.2 — `src/bot/lib/pending.ts`**
- [x] Implement `setPending(telegramId, value)` — `redis.set` with `EX 600`
- [x] Implement `getPending(telegramId)` — `redis.get`
- [x] Implement `clearPending(telegramId)` — `redis.del`

**0.3 — `src/bot/index.ts` — extend `message:text` handler**
- [x] Import `getPending`, `clearPending` from `../bot/lib/pending.js`
- [x] Import `parseAmount`, `parseLeverage` from `../bot/lib/fmt.js`
- [x] Replace the entire `bot.on("message:text", ...)` handler with the new dispatch map
- [x] Add `withdraw_amount` branch → call `sendWithdrawConfirm`
- [x] Add `trade_leverage:SIDE:SYMBOL` branch → validate int, call `sendSizePicker`
- [x] Add `trade_size:SIDE:SYMBOL:LEV` branch → validate amount, call `sendTradeConfirm`
- [x] Add `pricealert:SYMBOL` branch → validate price ≠ 0, call `sendPriceAlertConfirm`
- [x] Update `addmargin` branch → add balance check + confirmation screen before executing
- [x] Update `editsl` branch → call `sendSlModePicker` (not direct execution); handle price=0 → `sendRemoveSlConfirm`
- [x] Update `edittp` branch → call `sendTpModePicker`; handle price=0 → `sendRemoveTpConfirm`
- [x] Remove all inline `redis.set("pending:...", ..., "EX", 120)` calls (replaced by `setPending`)

**0.4 — `src/bot/commands/index.ts` — navigation callbacks and cancel cleanup**
- [x] Update `cancel` handler to call `clearPending(ctx.from.id)` before editing message
- [x] Add `nav:balance` callback → calls `sendBalanceScreen(ctx)`
- [x] Add `nav:deposit` callback → calls deposit screen function
- [x] Add `nav:withdraw` callback → calls `sendWithdrawAmountPrompt(ctx)`
- [x] Add `nav:positions` callback → calls `sendPositionsScreen(ctx)`
- [x] Add `nav:history` callback → calls `sendHistoryScreen(ctx)`

---

### Phase 1 — Account Overview (`balance.ts`)

- [x] Import `usd`, `shortAddr` from `../lib/fmt.js`
- [x] Import `InlineKeyboard` from `grammy`
- [x] Build risk tier emoji + label maps (`riskEmoji`, `riskLabel`)
- [x] Compute `totalValue = effectiveCollateral + unrealizedPnl + unsettledFunding`
- [x] Replace message body with new layout (Deposited / Available margin / P&L / Pending funding / Total value / Gas / Wallet / tier)
- [x] Add inline keyboard: `[📥 Deposit]` `[📤 Withdraw]` / `[📊 Positions]` `[📋 History]`
- [x] Export `sendBalanceScreen(ctx)` so nav callbacks can call it

---

### Phase 2 — Deposit (`deposit.ts`)

- [x] Import `InlineKeyboard` from `grammy`
- [x] Add `[← Back]` button → `nav:balance` callback
- [x] Replace caption: remove raw USDC mint address line; add "Only send standard USDC" note
- [x] Add "≈0.01 SOL for fees" note
- [x] Simplify closing line to "Funds arrive automatically — no extra steps needed."

---

### Phase 3 — Withdraw (`withdraw.ts`)

- [x] Import `parseAmount`, `usd`, `shortAddr` from `../lib/fmt.js`
- [x] Import `setPending` from `../lib/pending.js`
- [x] Export `sendWithdrawAmountPrompt(ctx)` — fetches `effectiveCollateral`, shows available, sets PS `withdraw_amount`
- [x] Export `sendWithdrawConfirm(ctx, amount)` — shows confirm + "Start withdrawal" + Cancel buttons
- [x] Add validation inside `sendWithdrawConfirm`: amount ≤ available (fetch trader state), amount ≥ $1
- [x] Update `/withdraw` command handler: if no args → call `sendWithdrawAmountPrompt`; if args → parse and call `sendWithdrawConfirm`
- [x] Update first-confirm callback label: "✅ Start withdrawal" (was "✅ Confirm")
- [x] Update waiting screen message to include `/withdraw <amount>` reminder for second confirm
- [x] Add `[✕ Cancel withdrawal]` button on waiting screen
- [x] Add `withdraw:cancel` callback handler → `redis.del` the pending key + edit message to "✕ Withdrawal cancelled."
- [x] Wrap success message to use `usd()` formatting
- [x] Update error message to mention `/balance` for checking funds

---

### Phase 4 — Markets (`markets.ts`)

- [x] Import `getMarketSnapshot` from `../../services/phoenix/market.js`
- [x] Import `price as fmtPrice`, `fundingApr` from `../lib/fmt.js`
- [x] In `sendMarketsPage`: fetch snapshots in parallel with `Promise.allSettled` for the visible page slice only
- [x] Update each market row to show: symbol, `[ISO]` tag if applicable, mark price, funding APR
- [x] Make each market row a tappable `InlineKeyboard` button → CB `price:SYMBOL`
- [x] Keep `◀ Prev` / `Next ▶` pagination buttons on a separate row below market buttons

---

### Phase 5 — Market Info (`price.ts`)

- [x] Import `price as fmtPrice`, `usd`, `fundingApr`, `fundingDir` from `../lib/fmt.js`
- [x] Import `isIsolatedOnly` from `../../services/phoenix/market.js`
- [x] Export `sendPriceScreen(ctx, symbol)` — usable by callback and command
- [x] Register `price:SYMBOL` callback query handler (was missing — only `/price` command existed)
- [x] Replace raw `fundingRate * 100` with `fundingApr(snapshot.fundingRate)` + `fundingDir()` label
- [x] Add extreme funding warning when `absApr > 100`
- [x] Format OI with `usd()`
- [x] Show taker fee as percentage
- [x] For isolated-only markets: disable long/short buttons; show explanatory note
- [x] Update market action keyboard buttons: "🟢 Buy / Long" and "🔴 Sell / Short" (was "Long"/"Short")
- [x] Add `[← Back]` button → `markets:page:0`
- [x] Wire `trade:long:SYMBOL` and `trade:short:SYMBOL` callbacks → delegated to `registerLong` / `registerShort` in the next phase (verify they don't collide with existing unhandled state in `market.ts` keyboard)

---

### Phase 6 — Open Trade — Long (`long.ts`)

**Keyboards (`src/bot/keyboards/trade.ts`)**
- [x] Import `usd` from `../lib/fmt.js`
- [x] Add `leveragePickerKeyboard(side, symbol, maxLeverage, defaultLeverage)` — buttons cap at `maxLeverage`, default highlighted with `★`, plus Custom + Cancel row
- [x] Add `sizePickerKeyboard(side, symbol, lev, availableMargin)` — 4 percentage tiers (10 / 25 / 50 / 100%) with dollar amounts, Custom + Back + Cancel row

**`long.ts` (full rewrite)**
- [x] Import all needed utilities (`fmt`, `pending`, `getTraderState`, `getMarketSnapshot`, etc.)
- [x] Export `sendSymbolPicker(ctx, side)` — popular markets buttons + "Browse all" button
- [x] Export `sendLeveragePicker(ctx, side, symbol)` — validates symbol exists + not isolated-only; fetches snapshot; calls `leveragePickerKeyboard`
- [x] Export `sendSizePicker(ctx, side, symbol, lev)` — fetches available margin; blocks if < $10; shows effective leverage cap warning; calls `sizePickerKeyboard`
- [x] Export `sendTradeConfirm(ctx, side, symbol, lev, sizeUsdc)` — validates amount ≤ available and ≥ $10; computes notional, liq price, fee, total cost; adds funding cost note if APR > 10%
- [x] Register `/long` command:
  - [x] No args → `sendSymbolPicker`
  - [x] Symbol only → `sendLeveragePicker`
  - [x] Full args (symbol + leverage + size) → `sendTradeConfirm` directly
  - [x] Validate isolated-only before proceeding
- [x] Register `trade:long:SYMBOL` callback → `sendLeveragePicker`
- [x] Register `trade_lev:long:SYMBOL:LEV` callback → `sendSizePicker`
- [x] Register `trade_lev_custom:long:SYMBOL` callback → reply + `setPending("trade_leverage:long:SYMBOL")`
- [x] Register `trade_size:long:SYMBOL:LEV:AMT` callback → `sendTradeConfirm`
- [x] Register `trade_size_custom:long:SYMBOL:LEV` callback → show available margin + `setPending("trade_size:long:SYMBOL:LEV")`
- [x] Register `confirm:long:SYMBOL:LEV:SIZE:PRICE` callback → call `placeMarketOrder` → success screen with `[View positions]` `[Set stop loss]` `[Set take profit]` buttons; error screen with `[Try again]` `[← Back]`

**`short.ts` (mirror of long.ts)**
- [x] Duplicate all of the above, replacing `"long"` with `"short"`, emoji `🟢` → `🔴`, label "Buy / Long" → "Sell / Short"
- [x] Liq price formula: `entry * (1 + 1 / effectiveLev)` (not `1 - 1/lev`)
- [x] `dirWord` = "rises to" (not "drops to")
- [x] All callback patterns use `short` in place of `long`

**`bot/index.ts` — new message:text branches (added in Phase 0)**
- [x] `trade_leverage:long:SYMBOL` → `parseLeverage`, validate 1–100, call `sendSizePicker` for long
- [x] `trade_leverage:short:SYMBOL` → same for short
- [x] `trade_size:long:SYMBOL:LEV` → `parseAmount`, validate ≥ $10, call `sendTradeConfirm` for long
- [x] `trade_size:short:SYMBOL:LEV` → same for short

---

### Phase 7 — Open Positions (`positions.ts`)

**`src/bot/keyboards/position.ts`**
- [x] Add `side: "long" | "short"` parameter to `positionKeyboard`
- [x] Change `editsl:${symbol}` → `editsl:${symbol}:${side}`
- [x] Change `edittp:${symbol}` → `edittp:${symbol}:${side}`
- [x] Rename "Close 100%" button label to "Close all"

**`positions.ts`**
- [x] Import `usd`, `price as fmtPrice` from `../lib/fmt.js`
- [x] Import `setPending` from `../lib/pending.js`
- [x] Export `sendPositionsScreen(ctx)` — empty-state message with `[Browse markets]` button; loops positions
- [x] Update position card layout: symbol/side/leverage header; size in base units + USD; entry / mark price; P&L; liquidation price
- [x] Pass `pos.side` to `positionKeyboard(pos.symbol, pos.side)`
- [x] Replace `close:SYMBOL:PCT` handler — fetch position, show confirm screen (closing amount, est. fee, P&L portion), buttons `[✅ Confirm close]` `[✕ Cancel]`
- [x] Add `close:exec:SYMBOL:PCT` handler — call `closePosition`; success screen with `[📊 Positions]` `[📋 History]`; error screen with `[Try again]`
- [x] Replace `margin:SYMBOL` handler — fetch trader state; show available margin + current liq price; block with deposit CTA if available ≤ 0; set PS `addmargin:SYMBOL`
- [x] Replace `editsl:SYMBOL` callback regex with `editsl:SYMBOL:SIDE` — call `sendSlPrompt` (imported from `setsl.ts`)
- [x] Replace `edittp:SYMBOL` callback regex with `edittp:SYMBOL:SIDE` — call `sendTpPrompt` (imported from `settp.ts`)
- [x] Add `addmargin:exec:SYMBOL:AMT` callback → call `addMargin`; success/error messages

**`bot/index.ts` — update `addmargin` branch**
- [x] After amount parsed: fetch trader state, check `amount ≤ available`
- [x] Show confirm screen with `[✅ Add margin]` → `addmargin:exec:SYMBOL:AMT` callback and `[✕ Cancel]`
- [x] Remove direct execution from `message:text` (execution now happens in the callback)

---

### Phase 8 — Stop Loss (`setsl.ts`)

- [x] Import `usd`, `price as fmtPrice`, `parseAmount` from `../lib/fmt.js`
- [x] Import `setPending` from `../lib/pending.js`
- [x] Export `sendSlPrompt(ctx, symbol, positionSide)` — fetches position for current price + liq price; instructs on direction; notes "send 0 to remove"; sets PS `editsl:SYMBOL:SIDE`
- [x] Export `sendSlModePicker(ctx, symbol, positionSide, triggerPrice)` — validates direction (long: price < mark; short: price > mark); validates price > liq price for longs; adds proximity warning if within 0.5%; shows Market vs Limit buttons
- [x] Export `sendRemoveSlConfirm(ctx, symbol, positionSide)` — confirm screen for removing SL
- [x] Implement private `sendSlFinalConfirm(ctx, symbol, triggerPrice, mode, positionSide)` — shows estimated max loss from entry; `[✅ Set stop loss]` → `sl:exec:...` callback
- [x] Update `/setsl` command:
  - [x] Full args (symbol + price + optional mode) → skip mode picker, call `sendSlFinalConfirm` directly
  - [x] Symbol only → fetch position side, call `sendSlPrompt`
  - [x] No args → usage help
- [x] Register `sl:mode:SYMBOL:PRICE:MODE:SIDE` callback → `sendSlFinalConfirm`
- [x] Register `sl:exec:SYMBOL:PRICE:MODE:SIDE` callback → call `setTpSl`; success message with "You'll be notified when it triggers."
- [x] Register `sl:remove:SYMBOL:SIDE` callback → call `cancelStopLoss`; success/error messages

### Phase 8 — Take Profit (`settp.ts`)

- [x] Mirror all of the above for take profit
- [x] Export `sendTpPrompt`, `sendTpModePicker`, `sendRemoveTpConfirm`
- [x] Direction validation reversed: long TP must be > mark price; short TP must be < mark price
- [x] Register `tp:mode:...`, `tp:exec:...`, `tp:remove:...` callbacks
- [x] Update `/settp` command (same structure as `/setsl`)

**`bot/index.ts` — update `editsl` and `edittp` branches**
- [x] `editsl` branch: price = 0 → call `sendRemoveSlConfirm`; price > 0 → call `sendSlModePicker`
- [x] `edittp` branch: price = 0 → call `sendRemoveTpConfirm`; price > 0 → call `sendTpModePicker`
- [x] Remove any remaining direct `setTpSl` calls from the `message:text` handler

---

### Phase 9 — Trade History (`history.ts`)

- [x] Import `usd`, `price as fmtPrice` from `../lib/fmt.js`
- [x] Import `InlineKeyboard` from `grammy`
- [x] Export `sendHistoryScreen(ctx)`
- [x] Empty-state: message with `[Browse markets]` → `markets:page:0` button
- [x] Trade rows: emoji (🟢/🔴) + symbol bold + formatted price + signed PnL in `<code>` + formatted date
- [x] Footer: "Showing 20 most recent." only when `history.hasMore` is true
- [x] Add `[← Account]` → `nav:balance` button

---

### Phase 10 — PnL (`pnl.ts`)

- [x] Import `usd` from `../lib/fmt.js`
- [x] Import `InlineKeyboard` from `grammy`
- [x] Apply signed `usd()` to both unrealizedPnl and unsettledFunding
- [x] Add inline keyboard: `[📊 Positions]` → `nav:positions` and `[📋 History]` → `nav:history`

---

### Phase 11 — Settings (`settings.ts`)

- [x] Build combined keyboard in `showSettings` — all slippage options in one row, all leverage options in the next row, highlights current value with `★` prefix
- [x] Show current values in the message body (not just as button labels)
- [x] Add `<i>★ = current selection</i>` footer note
- [x] `slip:BPS` callback: save to DB, then re-render the full settings panel in-place (`editMessageText` with new keyboard)
- [x] `lev:N` callback: same — save + re-render
- [x] Remove the intermediate "Select slippage tolerance:" / "Select default leverage:" intermediate screens (they're no longer needed since both rows live in the main panel)
- [x] `settings:alerts` callback: reply pointing to `/alerts` (keep as-is)

---

### Phase 12 — Price Alerts (`pricealert.ts`)

- [x] Import `price as fmtPrice`, `parseAmount` from `../lib/fmt.js`
- [x] Import `setPending` from `../lib/pending.js`
- [x] Export `sendPriceAlertPrompt(ctx, symbol)` — shows current price if available; explains +/− direction; sets PS `pricealert:SYMBOL`
- [x] Export `sendPriceAlertConfirm(ctx, symbol, p)` — validates direction vs current price; shows "reaches X ↑" or "falls to X ↓"; `[✅ Set alert]` → `pricealert:exec:SYMBOL:PRICE`
- [x] Register `pricealert:SYMBOL` callback (from price screen button) → call `sendPriceAlertPrompt`
- [x] Register `pricealert:exec:SYMBOL:PRICE` callback → insert DB row; show success message
- [x] Update `/alert` command:
  - [x] Full args (symbol + price) → call `sendPriceAlertConfirm` directly
  - [x] Symbol only → call `sendPriceAlertPrompt`
  - [x] No args → usage help
- [x] `bot/index.ts` — `pricealert:SYMBOL` message:text branch: parse price, validate ≠ 0, call `sendPriceAlertConfirm`

---

### Phase 13 — Alerts Management (`alerts.ts`)

- [x] Replace `DEFAULT_ALERTS` labels with human-friendly versions (no "AtRisk", "TPSL"):
  - `at_risk` → "Account at risk"
  - `cancellable` → "Orders may cancel"
  - `liquidatable` → "Near liquidation"
  - `fill` → "Order filled"
  - `tpsl_flip` → "TP/SL triggered"
  - `funding_flip` → "Funding direction change"
  - `large_funding` → "High funding rate (>50% APR)"
- [x] In `buildAlertsKeyboard`: change `subs.find((s) => s.type === a.type)` to also filter `s.symbol === null` to guard against price alert rows polluting the toggle state

---

### Phase 14 — Market keyboard labels (`keyboards/market.ts`)

- [x] Change `"Long"` button label → `"🟢 Buy / Long"`
- [x] Change `"Short"` button label → `"🔴 Sell / Short"`
- [x] Change `"Alert"` button label → `"🔔 Price alert"` and CB data → `pricealert:SYMBOL`
- [x] Change `"Price"` button label → `"📊 Info"` and CB data → `price:SYMBOL`

---

### Phase 15 — Cross-cutting & verification

- [x] Audit every `redis.set("pending:...", ..., "EX", 120)` call in all files — replace with `setPending()`
- [x] Verify `share.ts` uses `new InputFile(buffer, "filename.png")` (not raw `Buffer`) — fix if not
- [x] Run `npm run build` — confirm zero TypeScript errors
- [x] Run `npm run check` — Biome passes (format clean; remaining noNonNullAssertion + noUnusedTemplateLiteral in untouched files are pre-existing)
- [x] Run `npm test` — confirm existing unit tests still pass (7/7 passing)
- [ ] Manual smoke test: `/balance` → tap `[📥 Deposit]` → tap `[← Back]` — no crashes
- [ ] Manual smoke test: `/long` (no args) → tap a market → tap `5x` → tap `25%` → tap `✕ Cancel` — pending state cleared
- [ ] Manual smoke test: `/long BTC 10x 100` (one-liner) → goes straight to confirm screen
- [ ] Manual smoke test: `/positions` (no positions) → empty state message shown
- [ ] Manual smoke test: `/setsl BTC` (no price) → prompts for price → reply with price above mark → error message shown
- [ ] Manual smoke test: `/settings` → tap slippage → panel re-renders with ★ on new value
- [ ] Manual smoke test: `/markets` → tap a symbol → price screen shown → tap `[🟢 Buy / Long]` → leverage picker shown
