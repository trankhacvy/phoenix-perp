# Withdraw Flow — Redesign Plan

## Root-cause: why users can't withdraw

In `src/bot/commands/withdraw.ts` `sendWithdrawConfirm()`:

```ts
const available = Number(state.effectiveCollateral); // ← WRONG
if (amount > available) → block
```

`effectiveCollateral` = margin not locked in open positions.  
If user deposited $1 000 and is running a $800 position, `effectiveCollateral ≈ $200`. They try `/withdraw 500` → blocked, even though Phoenix would allow it.

The right field for "max withdrawable" is `depositedCollateral`. The fix is to show both values and only warn (not block) when the amount exceeds `effectiveCollateral`.

The second bug: the 5-minute security delay requires the user to retype `/withdraw <amount>` after the confirm message edits away the confirm button. The pending message has no button; there is no countdown; users abandon the flow.

---

## New flow overview

```
/withdraw
    │
    ▼
[Destination screen]
    ├─── Bot wallet     (Phoenix PDA → Privy wallet)
    │       │
    │       ▼
    │   [Amount screen]  → [Confirm] → tx → done
    │
    └─── External wallet  (Phoenix PDA → Privy wallet → external address)
            │
            ▼
        [Amount screen]  → [Address input] → [Confirm] → 2 txs → done
```

Key UX decisions:
- **No 5-minute delay.** Replace with a single explicit confirm.
- **Show both balances**: safe amount (`effectiveCollateral`) + max (`depositedCollateral`).
- **Preset buttons** (25 / 50 / 75 / 100% of safe) + "Max all" + custom.
- **External transfer** = separate second tx after Phoenix withdrawal confirms.
- **External address stored in Redis** (not callback_data) — Telegram callback_data max is 64 bytes; address alone is up to 44 chars.

---

## Phase 1 — Internal withdraw (Phoenix PDA → bot wallet)

This is the only required phase for the bug fix. External wallet is Phase 2.

---

## Implementation

### Step 1 — Add `@solana-program/token` dependency

The external USDC transfer (Phase 2) needs kit-native token instructions consistent with how `trade.ts` builds transactions.

```bash
pnpm add @solana-program/token
```

This package is part of the `@solana-program/*` namespace already used for `compute-budget` and `system`. Skip this step if only doing Phase 1.

---

### Step 2 — Add `transferUsdc` to `src/services/phoenix/trade.ts`

This function lives in `trade.ts` because it reuses the private `dispatchInstructions` / `getSigner` / `getBlockhash` helpers already defined there.

Append after `withdrawCollateral`:

```ts
// ── USDC SPL transfer (Privy wallet → external address) ─────────────────────
// Used in the external-wallet withdraw flow: after withdrawCollateral moves
// funds to the Privy wallet, this sends them onward.

import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

const USDC_MINT_ADDRESS =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const USDC_DECIMALS = 6;

export async function transferUsdc(
  fromAddress: string,
  toAddress: string,
  amountNative: bigint,
): Promise<string> {
  const from = fromAddress as Address;
  const to   = toAddress   as Address;

  const [sourceAta] = await findAssociatedTokenPda({
    owner: from,
    mint: USDC_MINT_ADDRESS,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const [destAta] = await findAssociatedTokenPda({
    owner: to,
    mint: USDC_MINT_ADDRESS,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  // createAssociatedTokenAccountIdempotent = no-op if ATA already exists.
  // This way we don't need a separate existence check.
  const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
    payer: from,
    ata: destAta,
    owner: to,
    mint: USDC_MINT_ADDRESS,
  });

  const transferIx = getTransferCheckedInstruction({
    source: sourceAta,
    mint: USDC_MINT_ADDRESS,
    destination: destAta,
    authority: from,
    amount: amountNative,
    decimals: USDC_DECIMALS,
  });

  // dispatchInstructions batches both into one tx (ATA create + transfer)
  return dispatchInstructions([createAtaIx, transferIx], fromAddress);
}
```

**Note:** verify exact export names from `@solana-program/token` against the installed version. The function names above follow the kit ecosystem convention (`get*Instruction`, `find*Pda`).

---

### Step 3 — Rewrite `src/bot/commands/withdraw.ts`

Full replacement. The file is self-contained; nothing outside it calls internal helpers.

```ts
import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { transferUsdc, withdrawCollateral } from "../../services/phoenix/trade.js";
import type { BotContext } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";
import { renderBotError } from "../lib/errors.js";
import { clearPending, setPending } from "../lib/pending.js";
import { parseAmount, shortAddr, solscanUrl, usd } from "../lib/fmt.js";
import { BASE58_RE } from "../lib/validate.js";

const MIN_WITHDRAW_USD = 1;

// ─── Redis helpers ────────────────────────────────────────────────────────────
// External withdraw stores address here because Telegram callback_data is
// limited to 64 bytes and a full Solana address (44 chars) + prefix leaves
// no room for an amount.

async function storeExtConfirm(
  telegramId: string,
  amount: number,
  toAddress: string,
): Promise<void> {
  await redis.set(
    `wd:ext:${telegramId}`,
    JSON.stringify({ amount, toAddress }),
    "EX",
    600,
  );
}

async function readExtConfirm(
  telegramId: string,
): Promise<{ amount: number; toAddress: string } | null> {
  const raw = await redis.get(`wd:ext:${telegramId}`);
  if (!raw) return null;
  return JSON.parse(raw) as { amount: number; toAddress: string };
}

async function clearExtConfirm(telegramId: string): Promise<void> {
  await redis.del(`wd:ext:${telegramId}`);
}

// ─── Shared balance fetch ─────────────────────────────────────────────────────

interface WithdrawBalances {
  safe: number;   // effectiveCollateral — won't affect open positions
  deposited: number; // depositedCollateral — absolute max
}

async function getWithdrawBalances(walletAddress: string): Promise<WithdrawBalances> {
  const state = await getTraderState(walletAddress);
  return {
    safe: Math.max(0, Number(state.effectiveCollateral)),
    deposited: Math.max(0, Number(state.depositedCollateral)),
  };
}

// ─── Screen builders ──────────────────────────────────────────────────────────

/**
 * Step 1: destination picker.
 * Explains what "withdraw" means before the user picks where funds go.
 */
export async function sendWithdrawDestScreen(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const { safe, deposited } = await getWithdrawBalances(ctx.user.walletAddress);

  if (deposited < MIN_WITHDRAW_USD) {
    const kb = new InlineKeyboard().text("📥 Deposit USDC", "nav:deposit");
    await ctx.reply(
      "Nothing to withdraw — your trading account is empty.",
      { reply_markup: kb },
    );
    return;
  }

  const kb = new InlineKeyboard()
    .text("📲 To bot wallet", "wd:internal")
    .row()
    .text("🏦 To external wallet", "wd:external")
    .row()
    .text("✕ Cancel", "cancel");

  const safeNote =
    safe < deposited
      ? fmt`\nSafe to withdraw (no open positions affected): ${FormattedString.b(usd(safe))}`
      : fmt``;

  const msg = fmt`📤 ${FormattedString.b("Withdraw USDC")}

${FormattedString.b("Trading account:")}  ${FormattedString.b(usd(deposited))}${safeNote}

Withdrawing moves funds ${FormattedString.b("out of Phoenix")} back to your wallet.

${FormattedString.b("Bot wallet")} — instant, one transaction.
Funds land in your Privy wallet (${FormattedString.code(shortAddr(ctx.user.walletAddress))}).

${FormattedString.b("External wallet")} — two transactions (Phoenix → bot wallet → you).
Requires extra gas (~0.001 SOL).`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

/**
 * Step 2: amount picker.
 * `dest` = "internal" | "external"
 * Preset buttons are % of safe (effectiveCollateral).
 * "Max all" uses depositedCollateral with a warning.
 */
export async function sendWithdrawAmountScreen(
  ctx: BotContext,
  dest: "internal" | "external",
  edit = false,
): Promise<void> {
  if (!ctx.user) return;

  const { safe, deposited } = await getWithdrawBalances(ctx.user.walletAddress);

  if (deposited < MIN_WITHDRAW_USD) {
    await ctx.reply("Nothing to withdraw — your trading account is empty.");
    return;
  }

  const label  = dest === "internal" ? "Bot wallet" : "External wallet";
  const prefix = dest === "internal" ? "int" : "ext";

  const kb = new InlineKeyboard();

  // 25 / 50 / 75 / 100% of safe amount
  const pcts = [25, 50, 75, 100];
  for (let i = 0; i < pcts.length; i++) {
    const p   = pcts[i];
    const amt = Math.floor((safe * p) / 100 * 100) / 100; // round down to cent
    if (amt >= MIN_WITHDRAW_USD) {
      const label100 = p === 100 ? "All safe" : `${p}%`;
      kb.text(`${label100}  ${usd(amt)}`, `wd:amt:${prefix}:${amt.toFixed(2)}`);
    }
    if (i % 2 === 1) kb.row();
  }

  // "Max all" only shown when deposited > safe (user has open positions)
  if (deposited > safe + 0.01) {
    kb.row().text(
      `⚠️ Max all  ${usd(deposited)}`,
      `wd:amt:${prefix}:${deposited.toFixed(2)}`,
    ).row();
  }

  kb.text("Enter custom amount", `wd:custom:${prefix}`)
    .row()
    .text("← Back", "wd:dest")
    .text("✕ Cancel", "cancel");

  const warnLine =
    safe < deposited
      ? fmt`\n⚠️ You have open positions. Amounts above ${FormattedString.b(usd(safe))} may affect them.`
      : fmt``;

  const msg = fmt`📤 ${FormattedString.b(`Withdraw — ${label}`)}

Trading account: ${FormattedString.b(usd(deposited))}
Safe to withdraw: ${FormattedString.b(usd(safe))}${warnLine}

How much?`;

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

/**
 * Step 3 (internal): confirm screen.
 */
export async function sendWithdrawConfirmInternal(
  ctx: BotContext,
  amount: number,
): Promise<void> {
  if (!ctx.user) return;

  const { deposited } = await getWithdrawBalances(ctx.user.walletAddress);

  if (amount < MIN_WITHDRAW_USD) {
    await ctx.reply(`Minimum withdrawal is ${usd(MIN_WITHDRAW_USD)}.`);
    return;
  }

  if (amount > deposited + 0.01) {
    await ctx.reply(
      `You only have ${usd(deposited)} in your trading account.`,
    );
    return;
  }

  const overSafe =
    amount > (await getWithdrawBalances(ctx.user.walletAddress)).safe + 0.01;
  const warnLine = overSafe
    ? fmt`\n⚠️ ${FormattedString.b("May affect open positions.")} Proceed if you understand the risk.`
    : fmt``;

  const kb = new InlineKeyboard()
    .text(`✅ Withdraw ${usd(amount)}`, `wd:exec:int:${amount.toFixed(2)}`)
    .row()
    .text("← Change amount", "wd:internal")
    .text("✕ Cancel", "cancel");

  const msg = fmt`📤 ${FormattedString.b("Confirm Withdrawal")}

Amount:  ${FormattedString.b(usd(amount))} USDC
From:    Phoenix trading account
To:      ${FormattedString.code(shortAddr(ctx.user.walletAddress))} (bot wallet)${warnLine}

Funds arrive in your bot wallet immediately after the transaction confirms.`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

/**
 * Step 3 (external): address input prompt.
 * Stores amount in pending key so the text handler can pass it forward.
 */
export async function sendWithdrawAddrStep(
  ctx: BotContext,
  amount: number,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;

  const kb = new InlineKeyboard().text("✕ Cancel", "cancel");
  const msg = fmt`📤 ${FormattedString.b("External Withdrawal — Step 2 of 3")}

Amount: ${FormattedString.b(usd(amount))}

Enter the ${FormattedString.b("destination Solana wallet address")}:
(must be a standard Solana address that can hold USDC)`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  await clearPending(ctx.from.id);
  // Encode amount as cents (integer) to avoid float parse issues in key
  await setPending(ctx.from.id, `withdraw_ext_addr:${amount.toFixed(2)}`);
}

/**
 * Step 4 (external): confirm screen.
 */
export async function sendWithdrawConfirmExternal(
  ctx: BotContext,
  amount: number,
  toAddress: string,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;

  const { deposited } = await getWithdrawBalances(ctx.user.walletAddress);

  if (amount < MIN_WITHDRAW_USD) {
    await ctx.reply(`Minimum withdrawal is ${usd(MIN_WITHDRAW_USD)}.`);
    return;
  }

  if (amount > deposited + 0.01) {
    await ctx.reply(
      `You only have ${usd(deposited)} in your trading account.`,
    );
    return;
  }

  // Store { amount, toAddress } in Redis; the exec callback reads it back.
  await storeExtConfirm(String(ctx.from.id), amount, toAddress);

  const kb = new InlineKeyboard()
    .text(`✅ Withdraw ${usd(amount)}`, "wd:exec:ext")
    .row()
    .text("← Change address", `wd:amt:ext:${amount.toFixed(2)}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`📤 ${FormattedString.b("Confirm External Withdrawal")}

Amount:  ${FormattedString.b(usd(amount))} USDC
From:    Phoenix trading account
To:      ${FormattedString.code(toAddress)}

⚠️ ${FormattedString.b("Two transactions:")}
  1. Phoenix → bot wallet
  2. Bot wallet → your address

Requires ~0.001 SOL for the second transaction's gas.
Double-check the address — transfers cannot be reversed.`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

// ─── Register ──────────────────────────────────────────────────────────────────

export function registerWithdraw(bot: Bot<BotContext>) {
  // Entry point
  bot.command("withdraw", async (ctx) => {
    if (!ctx.user) { await ctx.reply("Type /start first."); return; }
    if (!(await requireActivation(ctx))) return;
    await sendWithdrawDestScreen(ctx);
  });

  // ── Destination picker ────────────────────────────────────────────────────

  bot.callbackQuery("wd:dest", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendWithdrawDestScreen(ctx);
  });

  bot.callbackQuery("wd:internal", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendWithdrawAmountScreen(ctx, "internal", true);
  });

  bot.callbackQuery("wd:external", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendWithdrawAmountScreen(ctx, "external", true);
  });

  // ── Amount preset buttons ─────────────────────────────────────────────────

  bot.callbackQuery(/^wd:amt:int:([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const amount = Number(ctx.match[1]);
    await sendWithdrawConfirmInternal(ctx, amount);
  });

  bot.callbackQuery(/^wd:amt:ext:([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const amount = Number(ctx.match[1]);
    await sendWithdrawAddrStep(ctx, amount);
  });

  // ── Custom amount prompts ─────────────────────────────────────────────────

  bot.callbackQuery("wd:custom:int", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    const { deposited, safe } = await getWithdrawBalances(ctx.user.walletAddress);
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, "withdraw_custom:internal");
    const msg = fmt`Enter the amount to withdraw (USD):\nSafe: ${FormattedString.code(usd(safe))}  Max: ${FormattedString.code(usd(deposited))}`;
    await ctx.reply(msg.text, {
      entities: msg.entities,
      reply_markup: new InlineKeyboard().text("✕ Cancel", "cancel"),
    });
  });

  bot.callbackQuery("wd:custom:ext", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    const { deposited, safe } = await getWithdrawBalances(ctx.user.walletAddress);
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, "withdraw_custom:external");
    const msg = fmt`Enter the amount to withdraw (USD):\nSafe: ${FormattedString.code(usd(safe))}  Max: ${FormattedString.code(usd(deposited))}`;
    await ctx.reply(msg.text, {
      entities: msg.entities,
      reply_markup: new InlineKeyboard().text("✕ Cancel", "cancel"),
    });
  });

  // ── Execute: internal ─────────────────────────────────────────────────────

  bot.callbackQuery(/^wd:exec:int:([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Processing…");
    if (!ctx.user) return;

    const amount = Number(ctx.match[1]);
    const amountNative = BigInt(Math.round(amount * 1_000_000));

    try {
      const sig = await withdrawCollateral(ctx.user.walletAddress, amountNative);

      const msg = fmt`✅ ${FormattedString.b("Withdrawal complete")}

${FormattedString.b(usd(amount))} USDC is now in your bot wallet.

${FormattedString.link("View on Solscan →", solscanUrl(sig))}

Use /deposit to re-add it for trading, or send it to an external wallet from your Privy wallet.`;

      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error({ err, amount }, "withdrawCollateral failed");
      await renderBotError(ctx, err, { action: "Withdrawal", edit: true });
    }
  });

  // ── Execute: external ─────────────────────────────────────────────────────

  bot.callbackQuery("wd:exec:ext", async (ctx) => {
    await ctx.answerCallbackQuery("Processing…");
    if (!ctx.user || !ctx.from) return;

    const confirm = await readExtConfirm(String(ctx.from.id));
    if (!confirm) {
      await ctx.editMessageText("Session expired. Start again with /withdraw.");
      return;
    }

    const { amount, toAddress } = confirm;
    const amountNative = BigInt(Math.round(amount * 1_000_000));

    // Step 1: Phoenix PDA → Privy wallet
    let sig1: string;
    try {
      sig1 = await withdrawCollateral(ctx.user.walletAddress, amountNative);
    } catch (err) {
      logger.error({ err, amount, toAddress }, "External withdraw step 1 failed");
      await renderBotError(ctx, err, { action: "Withdrawal (step 1)", edit: true });
      return;
    }

    // Inform user that step 1 is done, step 2 in progress
    await ctx.editMessageText(
      `⏳ Step 1 done — moving funds to your address…`,
    );

    // Step 2: Privy wallet → external address
    let sig2: string;
    try {
      sig2 = await transferUsdc(ctx.user.walletAddress, toAddress, amountNative);
      await clearExtConfirm(String(ctx.from.id));
    } catch (err) {
      logger.error({ err, amount, toAddress }, "External withdraw step 2 failed");
      // USDC is now in Privy wallet — give user a recovery path
      const recoveryMsg = fmt`⚠️ ${FormattedString.b("Partial failure")}

${FormattedString.b(usd(amount))} USDC reached your bot wallet (step 1 ✅) but the transfer to your address failed.

Your funds are safe. Use /withdraw → ${FormattedString.b("To bot wallet")} to try again, or check that the destination address can receive USDC.

${FormattedString.link("Step 1 tx →", solscanUrl(sig1))}`;
      await ctx.editMessageText(recoveryMsg.text, {
        entities: recoveryMsg.entities,
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    const msg = fmt`✅ ${FormattedString.b("External withdrawal complete")}

${FormattedString.b(usd(amount))} USDC sent to:
${FormattedString.code(toAddress)}

${FormattedString.link("Step 1 (Phoenix → bot wallet) →", solscanUrl(sig1))}
${FormattedString.link("Step 2 (bot wallet → you) →", solscanUrl(sig2))}`;

    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      link_preview_options: { is_disabled: true },
    });
  });
}

// ─── Exported helpers for nav:withdraw ───────────────────────────────────────
// Used by bot/commands/index.ts and bot/index.ts

export { sendWithdrawDestScreen as sendWithdrawAmountPrompt };
```

---

### Step 4 — Update `src/bot/index.ts` pending handlers

The current file handles `"withdraw_amount"` at line 49. Replace those lines and add new handlers:

**Remove** (lines 49–58, current):
```ts
if (pending === "withdraw_amount") {
  await clearPending(ctx.from.id);
  const amount = parseAmount(text);
  if (Number.isNaN(amount) || amount <= 0) {
    await ctx.reply("Invalid amount. Try /withdraw again.");
    return;
  }
  await sendWithdrawConfirm(ctx, amount);
  return;
}
```

**Replace with:**
```ts
// Internal withdraw custom amount
if (pending === "withdraw_custom:internal") {
  await clearPending(ctx.from.id);
  const amount = parseAmount(text);
  if (Number.isNaN(amount) || amount <= 0) {
    await ctx.reply("Invalid amount. Enter a number like 50.");
    return;
  }
  await sendWithdrawConfirmInternal(ctx, amount);
  return;
}

// External withdraw custom amount → go to address step
if (pending === "withdraw_custom:external") {
  await clearPending(ctx.from.id);
  const amount = parseAmount(text);
  if (Number.isNaN(amount) || amount <= 0) {
    await ctx.reply("Invalid amount. Enter a number like 50.");
    return;
  }
  await sendWithdrawAddrStep(ctx, amount);
  return;
}

// External withdraw address input
if (parts[0] === "withdraw_ext_addr") {
  const amount = Number(parts[1]); // parts[1] = amount.toFixed(2)
  const address = text.trim();
  if (!BASE58_RE.test(address)) {
    await ctx.reply("Invalid Solana address. Send a valid base58 address.");
    return;
  }
  await clearPending(ctx.from.id);
  await sendWithdrawConfirmExternal(ctx, amount, address);
  return;
}
```

Also update the imports at the top of `bot/index.ts`:

```ts
// Remove:
import { sendWithdrawConfirm } from "./commands/withdraw.js";

// Add:
import {
  sendWithdrawAddrStep,
  sendWithdrawAmountPrompt,
  sendWithdrawConfirmExternal,
  sendWithdrawConfirmInternal,
} from "./commands/withdraw.js";
```

---

### Step 5 — Update `src/bot/commands/index.ts`

The `nav:withdraw` callback currently calls `sendWithdrawAmountPrompt` from the old file. The new file re-exports `sendWithdrawDestScreen` under that alias, so the callback registration itself stays the same. Just verify the import is correct:

```ts
// In bot/commands/index.ts — this stays unchanged:
import { registerWithdraw, sendWithdrawAmountPrompt } from "./withdraw.js";

// The nav:withdraw callback also stays unchanged:
bot.callbackQuery("nav:withdraw", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;
  if (!(await requireActivation(ctx))) return;
  await sendWithdrawAmountPrompt(ctx);  // now shows destination picker
});
```

---

### Step 6 — Remove the 5-minute delay

The old `withdraw.ts` had:

```ts
const SECURITY_DELAY_SECONDS = 300;
const pendingKey = `withdraw:pending:${ctx.user.id}`;
// ... Redis timer logic
```

This is entirely removed. It doesn't exist in the new file. No cleanup needed elsewhere — the Redis keys will expire on their own (they had `EX SECURITY_DELAY_SECONDS + 60` = 6 min TTL).

---

## Callback data reference

| Callback | Triggered by | Action |
|----------|-------------|--------|
| `wd:dest` | "← Back" from amount screens | Show dest screen |
| `wd:internal` | "📲 To bot wallet" | Amount screen (internal) |
| `wd:external` | "🏦 To external wallet" | Amount screen (external) |
| `wd:amt:int:<amount>` | Preset % buttons | Confirm screen (internal) |
| `wd:amt:ext:<amount>` | Preset % buttons | Address input step |
| `wd:custom:int` | "Enter custom" | Set pending, ask for text |
| `wd:custom:ext` | "Enter custom" | Set pending, ask for text |
| `wd:exec:int:<amount>` | "✅ Withdraw" (internal confirm) | Execute `withdrawCollateral` |
| `wd:exec:ext` | "✅ Withdraw" (external confirm) | Execute both txs |

## Pending state reference

| Pending key | Text handler action |
|-------------|---------------------|
| `withdraw_custom:internal` | Parse amount → `sendWithdrawConfirmInternal` |
| `withdraw_custom:external` | Parse amount → `sendWithdrawAddrStep` |
| `withdraw_ext_addr:<amount>` | Validate base58 → `sendWithdrawConfirmExternal` |

---

## Edge cases

### Amount between `effectiveCollateral` and `depositedCollateral`

Show warning on confirm screen (implemented above via `overSafe` check). Let Phoenix reject at execution if it truly can't withdraw — `renderBotError` with the SDK error pattern already handles `INSUFFICIENT_MARGIN` messages.

### External step 2 failure (USDC stuck in Privy wallet)

Handled explicitly: show recovery message directing user back to `/withdraw → To bot wallet`. USDC is not lost — it's in the Privy wallet. The bot wallet balance (`getWalletUsdcBalance`) will show it, and the portfolio screen already surfaces "idle USDC" with an "Add Collateral" nudge.

### SOL balance check before external withdraw

The Privy wallet needs SOL for the step 2 gas fee. Pre-flight check in `sendWithdrawConfirmExternal`:

```ts
// Add before storeExtConfirm():
import { Connection, PublicKey } from "@solana/web3.js";

const solConn = new Connection(config.HELIUS_RPC_URL, "confirmed");
const lamports = await solConn.getBalance(new PublicKey(ctx.user.walletAddress));
const MIN_SOL_FOR_GAS = 0.001 * 1e9; // 0.001 SOL in lamports
if (lamports < MIN_SOL_FOR_GAS) {
  const solBal = (lamports / 1e9).toFixed(4);
  await ctx.reply(
    `Not enough SOL for gas (have ${solBal} SOL, need ~0.001).\n\nSend a small amount of SOL to your bot wallet first:\n${ctx.user.walletAddress}`,
  );
  return;
}
```

### `0.00` amounts from rounding

The `Math.floor(...* 100) / 100` in preset button generation could yield `0.00` for very small balances. The `if (amt >= MIN_WITHDRAW_USD)` guard skips those buttons.

---

## What is NOT in this plan

- Changing `depositCollateral` / `withdrawCollateral` in `trade.ts` — no changes needed there
- DB schema changes — none required
- WS worker changes — the WS worker already fires fill/collateral alerts on withdrawal
- Removing old `withdraw:pending:*` Redis keys from production — they expire within 6 min of their TTL; no migration needed
