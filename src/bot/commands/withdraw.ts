import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { getTraderState } from "../../services/phoenix/position.js";
import {
  getUsdcAtaBalanceNative,
  transferUsdc,
  withdrawCollateral,
} from "../../services/phoenix/trade.js";
import {
  getSolBalance,
  getWalletUsdcBalance,
} from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";
import { toBotError } from "../lib/errors.js";
import { shortAddr, solscanUrl, usd } from "../lib/fmt.js";
import { clearPending, setPending } from "../lib/pending.js";
import { checkOrderRateLimit } from "../middleware/rate-limit.js";

const MIN_WITHDRAW_USD = 1;
const MIN_SOL_FOR_GAS = 0.001;
// Longer than the 120s tx poll timeout so a failed exec can never be retried
// while the lock is still hot.
const EXEC_LOCK_TTL = 150;

type ExtSource = "trading" | "wallet";

// ─── Redis helpers ─────────────────────────────────────────────────────────────

async function storeExtConfirm(
  telegramId: string,
  amount: number,
  toAddress: string,
  source: ExtSource,
): Promise<void> {
  await redis.set(
    `wd:ext:${telegramId}`,
    JSON.stringify({ amount, toAddress, source }),
    "EX",
    600,
  );
}

// Atomically consumes the ext confirm key — only the first concurrent caller
// succeeds; subsequent callers get null. Prevents double-submit.
async function consumeExtConfirm(
  telegramId: string,
): Promise<{ amount: number; toAddress: string; source: ExtSource } | null> {
  const raw = await redis.getdel(`wd:ext:${telegramId}`);
  if (!raw) return null;
  return JSON.parse(raw) as { amount: number; toAddress: string; source: ExtSource };
}

export async function clearWithdrawExtState(telegramId: string): Promise<void> {
  await redis.del(`wd:ext:${telegramId}`);
}

// ─── Balances ─────────────────────────────────────────────────────────────────

interface WithdrawBalances {
  safe: number; // Phoenix collateral free of open-position risk
  deposited: number; // total Phoenix collateral
  walletUsdc: number; // idle USDC sitting in bot wallet
}

export async function getWithdrawBalances(walletAddress: string): Promise<WithdrawBalances> {
  const [state, walletUsdc] = await Promise.all([
    getTraderState(walletAddress),
    getWalletUsdcBalance(walletAddress).catch(() => 0),
  ]);
  return {
    safe: Math.max(0, Number(state.effectiveCollateral)),
    deposited: Math.max(0, Number(state.depositedCollateral)),
    walletUsdc: Math.max(0, walletUsdc),
  };
}

// ─── Source picker (entry point) ──────────────────────────────────────────────

export async function sendWithdrawSourceScreen(ctx: BotContext, edit = false): Promise<void> {
  if (!ctx.user) return;

  const { safe, deposited, walletUsdc } = await getWithdrawBalances(ctx.user.walletAddress);

  const hasTrading = deposited >= MIN_WITHDRAW_USD;
  const hasWallet = walletUsdc >= MIN_WITHDRAW_USD;

  if (!hasTrading && !hasWallet) {
    const kb = new InlineKeyboard().text("📥 Deposit USDC", "nav:deposit");
    const text = "Nothing to withdraw — both your trading account and bot wallet are empty.";
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: kb });
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
    return;
  }

  // Single-source shortcuts — skip the picker.
  if (hasTrading && !hasWallet) {
    await sendWithdrawTradingDestScreen(ctx, edit);
    return;
  }
  if (!hasTrading && hasWallet) {
    await sendWithdrawWalletAmountScreen(ctx, edit);
    return;
  }

  // Both have funds — let user pick source.
  const kb = new InlineKeyboard()
    .text("📊 From trading account", "wd:src:trading")
    .row()
    .text("💳 From bot wallet", "wd:src:wallet")
    .row()
    .text("✕ Cancel", "cancel");

  const safeNote =
    safe < deposited
      ? fmt`\n${FormattedString.i(`Safe to withdraw from trading: ${usd(safe)}`)}`
      : fmt``;

  const msg = fmt`📤 ${FormattedString.b("Withdraw USDC")}

📊 Trading account   ${FormattedString.b(usd(deposited))}
💳 Bot wallet        ${FormattedString.b(usd(walletUsdc))}${safeNote}

Where would you like to withdraw from?`;

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

// ─── Trading-source destination picker ────────────────────────────────────────

export async function sendWithdrawTradingDestScreen(
  ctx: BotContext,
  edit = false,
): Promise<void> {
  if (!ctx.user) return;

  const { safe, deposited, walletUsdc } = await getWithdrawBalances(ctx.user.walletAddress);

  if (deposited < MIN_WITHDRAW_USD) {
    // Race: balance shifted since source-picker check. Re-route.
    await sendWithdrawSourceScreen(ctx, edit);
    return;
  }

  const kb = new InlineKeyboard()
    .text("📲 To bot wallet", "wd:internal")
    .row()
    .text("🏦 To external wallet", "wd:external")
    .row();

  if (walletUsdc >= MIN_WITHDRAW_USD) {
    kb.text("← Back", "wd:src");
  }
  kb.text("✕ Cancel", "cancel");

  const safeNote =
    safe < deposited
      ? fmt`\nSafe to withdraw (no open positions affected): ${FormattedString.b(usd(safe))}`
      : fmt``;

  const msg = fmt`📤 ${FormattedString.b("Withdraw from Trading Account")}

${FormattedString.b("Trading account:")}  ${FormattedString.b(usd(deposited))}${safeNote}

Where should the USDC go?

${FormattedString.b("Bot wallet")} — instant, one transaction.
Funds land in your Privy wallet (${FormattedString.code(shortAddr(ctx.user.walletAddress))}).

${FormattedString.b("External wallet")} — two transactions (Phoenix → bot wallet → you).
Requires extra gas (~0.001 SOL).`;

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

// ─── Amount picker — trading source (internal or external) ───────────────────

export async function sendWithdrawAmountScreen(
  ctx: BotContext,
  dest: "internal" | "external",
  edit = false,
): Promise<void> {
  if (!ctx.user) return;

  const { safe, deposited } = await getWithdrawBalances(ctx.user.walletAddress);

  if (deposited < MIN_WITHDRAW_USD) {
    await sendWithdrawSourceScreen(ctx, edit);
    return;
  }

  const label = dest === "internal" ? "Bot wallet" : "External wallet";
  const prefix = dest === "internal" ? "int" : "ext";

  const kb = new InlineKeyboard();

  const pcts = [25, 50, 75, 100];
  for (let i = 0; i < pcts.length; i++) {
    const p = pcts[i];
    const amt = Math.floor(((safe * p) / 100) * 100) / 100;
    if (amt >= MIN_WITHDRAW_USD) {
      const btnLabel = p === 100 ? "Max safe" : `${p}%`;
      kb.text(`${btnLabel}  ${usd(amt)}`, `wd:amt:${prefix}:${amt.toFixed(2)}`);
    }
    if (i % 2 === 1) kb.row();
  }

  if (deposited > safe + 0.01) {
    kb.row()
      .text(`⚠️ Max all  ${usd(deposited)}`, `wd:amt:${prefix}:${deposited.toFixed(2)}`)
      .row();
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

// ─── Amount picker — wallet source (always external) ─────────────────────────

export async function sendWithdrawWalletAmountScreen(
  ctx: BotContext,
  edit = false,
): Promise<void> {
  if (!ctx.user) return;

  const { walletUsdc, deposited } = await getWithdrawBalances(ctx.user.walletAddress);

  if (walletUsdc < MIN_WITHDRAW_USD) {
    await sendWithdrawSourceScreen(ctx, edit);
    return;
  }

  const kb = new InlineKeyboard();
  const pcts = [25, 50, 75, 100];
  for (let i = 0; i < pcts.length; i++) {
    const p = pcts[i];
    const amt = Math.floor(((walletUsdc * p) / 100) * 100) / 100;
    if (amt >= MIN_WITHDRAW_USD) {
      const btnLabel = p === 100 ? "Max" : `${p}%`;
      kb.text(`${btnLabel}  ${usd(amt)}`, `wd:amt:wal:${amt.toFixed(2)}`);
    }
    if (i % 2 === 1) kb.row();
  }

  kb.text("Enter custom amount", "wd:custom:wal").row();

  // Show Back only if user has a choice of source — otherwise back goes to "nothing to withdraw"
  if (deposited >= MIN_WITHDRAW_USD) {
    kb.text("← Back", "wd:src");
  }
  kb.text("✕ Cancel", "cancel");

  const msg = fmt`📤 ${FormattedString.b("Send from Bot Wallet")}

Bot wallet: ${FormattedString.b(usd(walletUsdc))} USDC

Sends USDC directly from your bot wallet to an external Solana address.
Single transaction. Requires ~0.001 SOL for gas.

How much?`;

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

// ─── Confirm screens ──────────────────────────────────────────────────────────

export async function sendWithdrawConfirmInternal(ctx: BotContext, amount: number): Promise<void> {
  if (!ctx.user) return;

  const { safe, deposited } = await getWithdrawBalances(ctx.user.walletAddress);

  if (amount < MIN_WITHDRAW_USD) {
    await ctx.reply(`Minimum withdrawal is ${usd(MIN_WITHDRAW_USD)}.`);
    return;
  }

  if (amount > deposited + 0.01) {
    await ctx.reply(`You only have ${usd(deposited)} in your trading account.`);
    return;
  }

  const warnLine =
    amount > safe + 0.01
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

export async function sendWithdrawAddrStep(
  ctx: BotContext,
  amount: number,
  source: ExtSource,
): Promise<void> {
  if (!ctx.user || !ctx.from) return;

  const kb = new InlineKeyboard().text("✕ Cancel", "cancel");
  const sourceLabel = source === "trading" ? "Trading account" : "Bot wallet";
  const stepLabel = source === "trading" ? "Step 2 of 3" : "Step 2 of 2";

  const msg = fmt`📤 ${FormattedString.b(`Send from ${sourceLabel} — ${stepLabel}`)}

Amount: ${FormattedString.b(usd(amount))}

Enter the ${FormattedString.b("destination Solana wallet address")}:
(must be a standard Solana address that can hold USDC)`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  await clearPending(ctx.from.id);
  await setPending(ctx.from.id, `withdraw_ext_addr:${amount.toFixed(2)}:${source}`);
}

export async function sendWithdrawConfirmExternal(
  ctx: BotContext,
  amount: number,
  toAddress: string,
  source: ExtSource = "trading",
): Promise<void> {
  if (!ctx.user || !ctx.from) return;

  const balances = await getWithdrawBalances(ctx.user.walletAddress);

  if (amount < MIN_WITHDRAW_USD) {
    await ctx.reply(`Minimum withdrawal is ${usd(MIN_WITHDRAW_USD)}.`);
    return;
  }

  const sourceBalance = source === "trading" ? balances.deposited : balances.walletUsdc;
  const sourceLabel = source === "trading" ? "trading account" : "bot wallet";
  if (amount > sourceBalance + 0.01) {
    await ctx.reply(`You only have ${usd(sourceBalance)} in your ${sourceLabel}.`);
    return;
  }

  const sol = await getSolBalance(ctx.user.walletAddress);
  if (sol < MIN_SOL_FOR_GAS) {
    await ctx.reply(
      `Not enough SOL for gas (have ${sol.toFixed(4)} SOL, need ~${MIN_SOL_FOR_GAS}).\n\nSend a small amount of SOL to your bot wallet first:\n${ctx.user.walletAddress}`,
    );
    return;
  }

  await storeExtConfirm(String(ctx.from.id), amount, toAddress, source);

  const backCallback = source === "trading" ? "wd:amt:ext" : "wd:wallet";
  const kb = new InlineKeyboard()
    .text(`✅ Withdraw ${usd(amount)}`, "wd:exec:ext")
    .row()
    .text("← Change address", backCallback)
    .text("✕ Cancel", "cancel");

  const txWarning =
    source === "trading"
      ? fmt`⚠️ ${FormattedString.b("Two transactions:")}
  1. Phoenix → bot wallet
  2. Bot wallet → your address

Requires ~${MIN_SOL_FOR_GAS} SOL for the second transaction's gas.`
      : fmt`${FormattedString.b("One transaction:")} bot wallet → your address.
Requires ~${MIN_SOL_FOR_GAS} SOL for gas.`;

  const fromLabel = source === "trading" ? "Phoenix trading account" : "Bot wallet";

  const msg = fmt`📤 ${FormattedString.b("Confirm External Withdrawal")}

Amount:  ${FormattedString.b(usd(amount))} USDC
From:    ${fromLabel}
To:      ${FormattedString.code(toAddress)}

${txWarning}
Double-check the address — transfers cannot be reversed.`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

// ─── Register ─────────────────────────────────────────────────────────────────

export function registerWithdraw(bot: Bot<BotContext>) {
  bot.command("withdraw", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }
    if (!(await requireActivation(ctx))) return;
    await sendWithdrawSourceScreen(ctx);
  });

  // Back-to-source-picker (used by "← Back" on dest picker / wallet amount picker)
  bot.callbackQuery("wd:src", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendWithdrawSourceScreen(ctx, true);
  });

  // Source picker → trading
  bot.callbackQuery("wd:src:trading", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendWithdrawTradingDestScreen(ctx, true);
  });

  // Source picker → wallet (skip dest picker, go to amount)
  bot.callbackQuery("wd:src:wallet", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendWithdrawWalletAmountScreen(ctx, true);
  });

  // Back-to-trading-dest-picker (used by "← Back" on int/ext amount picker)
  bot.callbackQuery("wd:dest", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendWithdrawTradingDestScreen(ctx, true);
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

  // Wallet-source amount picker (also used by "← Change address" from wallet→external confirm)
  bot.callbackQuery("wd:wallet", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendWithdrawWalletAmountScreen(ctx, true);
  });

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
    await sendWithdrawAddrStep(ctx, amount, "trading");
  });

  // "← Change address" on trading→external confirm goes back to amount picker.
  bot.callbackQuery("wd:amt:ext", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendWithdrawAmountScreen(ctx, "external", true);
  });

  bot.callbackQuery(/^wd:amt:wal:([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const amount = Number(ctx.match[1]);
    await sendWithdrawAddrStep(ctx, amount, "wallet");
  });

  // Custom amount prompts — one per flow
  async function customPrompt(
    ctx: BotContext,
    pendingKey: string,
    maxLabel: string,
    maxValue: number,
  ) {
    if (!ctx.user || !ctx.from) return;
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, pendingKey);
    const msg = fmt`Enter the amount to withdraw (USD):\n${maxLabel}: ${FormattedString.code(usd(maxValue))}`;
    await ctx.reply(msg.text, {
      entities: msg.entities,
      reply_markup: new InlineKeyboard().text("✕ Cancel", "cancel"),
    });
  }

  bot.callbackQuery("wd:custom:int", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const { safe, deposited } = await getWithdrawBalances(ctx.user.walletAddress);
    await customPrompt(
      ctx,
      "withdraw_custom:internal",
      safe < deposited ? `Safe: ${usd(safe)}  Max` : "Max",
      deposited,
    );
  });

  bot.callbackQuery("wd:custom:ext", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const { safe, deposited } = await getWithdrawBalances(ctx.user.walletAddress);
    await customPrompt(
      ctx,
      "withdraw_custom:external",
      safe < deposited ? `Safe: ${usd(safe)}  Max` : "Max",
      deposited,
    );
  });

  bot.callbackQuery("wd:custom:wal", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const { walletUsdc } = await getWithdrawBalances(ctx.user.walletAddress);
    await customPrompt(ctx, "withdraw_custom:wallet", "Max", walletUsdc);
  });

  // ── Execute: internal (trading → bot wallet) ───────────────────────────────

  bot.callbackQuery(/^wd:exec:int:([\d.]+)$/, async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (!(await checkOrderRateLimit(ctx))) return;

    const lockKey = `wd:lock:int:${ctx.user.id}`;
    const locked = await redis.set(lockKey, "1", "EX", EXEC_LOCK_TTL, "NX");
    if (!locked) {
      await ctx.answerCallbackQuery({ text: "Already processing…", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery("Processing…");
    const amount = Number(ctx.match[1]);
    const amountNative = BigInt(Math.round(amount * 1_000_000));

    const { deposited } = await getWithdrawBalances(ctx.user.walletAddress);
    if (amount > deposited + 0.01) {
      await redis.del(lockKey);
      await ctx.editMessageText(
        `Balance changed — you only have ${usd(deposited)} available. Use /withdraw to start again.`,
      );
      return;
    }

    await ctx.editMessageText("⏳ Processing withdrawal…");

    const user = ctx.user;
    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !msgId) {
      await redis.del(lockKey);
      return;
    }
    const api = ctx.api;

    void (async () => {
      try {
        const sig = await withdrawCollateral(user.walletAddress, amountNative);
        await redis.del(lockKey);

        const msg = fmt`✅ ${FormattedString.b("Withdrawal complete")}

${FormattedString.b(usd(amount))} USDC is now in your bot wallet.

${FormattedString.link("View on Solscan →", solscanUrl(sig))}

Use /deposit to re-add it for trading, or /withdraw to send it to an external wallet.`;

        await api.editMessageText(chatId, msgId, msg.text, {
          entities: msg.entities,
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        logger.error({ err, amount }, "withdrawCollateral failed");
        await redis.del(lockKey);
        const be = toBotError(err);
        const hintLine = be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``;
        const retryLine = be.retryable ? fmt`\n\n↩️ ${FormattedString.i("Safe to retry.")}` : fmt``;
        const errMsg = fmt`${FormattedString.b("❌ Withdrawal failed")}\n\n${be.userMessage}${hintLine}${retryLine}`;
        try {
          await api.editMessageText(chatId, msgId, errMsg.text, { entities: errMsg.entities });
        } catch (editErr) {
          logger.warn({ err: editErr }, "failed to edit error message after withdraw failure");
        }
      }
    })().catch((err) => logger.error({ err }, "withdraw internal async error"));
  });

  // ── Execute: external (trading→external or wallet→external) ────────────────

  bot.callbackQuery("wd:exec:ext", async (ctx) => {
    if (!ctx.user || !ctx.from) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (!(await checkOrderRateLimit(ctx))) return;

    const confirm = await consumeExtConfirm(String(ctx.from.id));
    if (!confirm) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Session expired. Start again with /withdraw.");
      return;
    }

    const { source } = confirm;
    const lockKey = `wd:lock:ext:${ctx.user.id}`;
    const locked = await redis.set(lockKey, "1", "EX", EXEC_LOCK_TTL, "NX");
    if (!locked) {
      await storeExtConfirm(String(ctx.from.id), confirm.amount, confirm.toAddress, source);
      await ctx.answerCallbackQuery({ text: "Already processing…", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery("Processing…");
    await ctx.editMessageText(
      source === "trading"
        ? "⏳ Processing external withdrawal…"
        : "⏳ Sending USDC to your address…",
    );

    const user = ctx.user;
    const fromId = String(ctx.from.id);
    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !msgId) {
      await redis.del(lockKey);
      return;
    }
    const api = ctx.api;

    const { amount, toAddress } = confirm;
    const amountNative = BigInt(Math.round(amount * 1_000_000));

    void (async () => {
      // Step 1: trading source only — pull funds from Phoenix into bot wallet
      let sig1: string | null = null;
      if (source === "trading") {
        try {
          sig1 = await withdrawCollateral(user.walletAddress, amountNative);
        } catch (err) {
          logger.error({ err, amount, toAddress }, "External withdraw step 1 failed");
          await redis.del(lockKey);
          await storeExtConfirm(fromId, amount, toAddress, source);
          const be = toBotError(err);
          const errMsg = fmt`${FormattedString.b("❌ Withdrawal (step 1) failed")}\n\n${be.userMessage}${be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``}`;
          try {
            await api.editMessageText(chatId, msgId, errMsg.text, { entities: errMsg.entities });
          } catch (editErr) {
            logger.warn({ err: editErr }, "failed to edit error after ext withdraw step 1");
          }
          return;
        }

        try {
          await api.editMessageText(
            chatId,
            msgId,
            "⏳ Step 1 done — moving funds to your address…",
          );
        } catch {
          /* best effort */
        }
      }

      // Step 2: bot wallet → external address
      const actualBalance = await getUsdcAtaBalanceNative(user.walletAddress);
      const transferAmount = actualBalance < amountNative ? actualBalance : amountNative;

      if (transferAmount <= 0n) {
        await redis.del(lockKey);
        const errMsg = fmt`${FormattedString.b("❌ Nothing to send")}\n\nNo USDC found in bot wallet to forward.`;
        try {
          await api.editMessageText(chatId, msgId, errMsg.text, { entities: errMsg.entities });
        } catch (editErr) {
          logger.warn({ err: editErr }, "failed to edit empty-balance message");
        }
        return;
      }

      let sig2: string;
      try {
        sig2 = await transferUsdc(user.walletAddress, toAddress, transferAmount);
      } catch (err) {
        logger.error({ err, amount, toAddress, source }, "External withdraw step 2 failed");
        await redis.del(lockKey);

        // For trading source: funds are stuck in bot wallet. Re-queue confirm with wallet source so
        // retry actually works (trading account is now empty).
        if (source === "trading" && sig1) {
          await storeExtConfirm(fromId, amount, toAddress, "wallet");
          const recoveryMsg = fmt`⚠️ ${FormattedString.b("Partial failure")}

${FormattedString.b(usd(amount))} USDC reached your bot wallet (step 1 ✅) but the transfer to your address failed.

Your funds are safe in your bot wallet. Run /withdraw again — you'll see a ${FormattedString.b("From bot wallet")} option to retry the transfer (1 transaction, no Phoenix step).

${FormattedString.link("Step 1 tx →", solscanUrl(sig1))}`;
          try {
            await api.editMessageText(chatId, msgId, recoveryMsg.text, {
              entities: recoveryMsg.entities,
              link_preview_options: { is_disabled: true },
            });
          } catch (editErr) {
            logger.warn(
              { err: editErr },
              "failed to edit recovery message after ext withdraw step 2",
            );
          }
        } else {
          // wallet source: simpler — funds stayed in wallet. Re-queue same confirm.
          await storeExtConfirm(fromId, amount, toAddress, source);
          const be = toBotError(err);
          const errMsg = fmt`${FormattedString.b("❌ Transfer failed")}\n\n${be.userMessage}${be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``}${be.retryable ? fmt`\n\n↩️ ${FormattedString.i("Safe to retry.")}` : fmt``}`;
          try {
            await api.editMessageText(chatId, msgId, errMsg.text, { entities: errMsg.entities });
          } catch (editErr) {
            logger.warn({ err: editErr }, "failed to edit wallet→ext error");
          }
        }
        return;
      }

      await redis.del(lockKey);
      const displayAmount = Number(transferAmount) / 1_000_000;
      const successHeader =
        source === "trading"
          ? fmt`✅ ${FormattedString.b("External withdrawal complete")}`
          : fmt`✅ ${FormattedString.b("USDC sent")}`;
      const txLinks =
        source === "trading" && sig1
          ? fmt`${FormattedString.link("Step 1 (Phoenix → bot wallet) →", solscanUrl(sig1))}
${FormattedString.link("Step 2 (bot wallet → you) →", solscanUrl(sig2))}`
          : fmt`${FormattedString.link("View on Solscan →", solscanUrl(sig2))}`;

      const msg = fmt`${successHeader}

${FormattedString.b(usd(displayAmount))} USDC sent to:
${FormattedString.code(toAddress)}

${txLinks}`;

      try {
        await api.editMessageText(chatId, msgId, msg.text, {
          entities: msg.entities,
          link_preview_options: { is_disabled: true },
        });
      } catch (editErr) {
        logger.warn({ err: editErr }, "failed to edit success message after ext withdraw");
      }
    })().catch((err) => logger.error({ err }, "withdraw external async error"));
  });
}

export { sendWithdrawSourceScreen as sendWithdrawAmountPrompt };
