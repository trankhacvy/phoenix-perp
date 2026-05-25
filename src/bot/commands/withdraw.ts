import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { getTraderState } from "../../services/phoenix/position.js";
import {
  getUsdcAtaBalanceNative,
  transferUsdc,
  withdrawCollateral,
} from "../../services/phoenix/trade.js";
import type { BotContext } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";
import { toBotError } from "../lib/errors.js";
import { shortAddr, solscanUrl, usd } from "../lib/fmt.js";
import { clearPending, setPending } from "../lib/pending.js";

const MIN_WITHDRAW_USD = 1;
const MIN_SOL_FOR_GAS = 0.001 * 1e9;
// Longer than the 120s tx poll timeout so a failed exec can never be retried
// while the lock is still hot.
const EXEC_LOCK_TTL = 150;

// ─── Redis helpers ─────────────────────────────────────────────────────────────

async function storeExtConfirm(
  telegramId: string,
  amount: number,
  toAddress: string,
): Promise<void> {
  await redis.set(`wd:ext:${telegramId}`, JSON.stringify({ amount, toAddress }), "EX", 600);
}

// Atomically consumes the ext confirm key — only the first concurrent caller
// succeeds; subsequent callers get null. Prevents double-submit.
async function consumeExtConfirm(
  telegramId: string,
): Promise<{ amount: number; toAddress: string } | null> {
  const raw = await redis.getdel(`wd:ext:${telegramId}`);
  if (!raw) return null;
  return JSON.parse(raw) as { amount: number; toAddress: string };
}

export async function clearWithdrawExtState(telegramId: string): Promise<void> {
  await redis.del(`wd:ext:${telegramId}`);
}

// ─── Balances ─────────────────────────────────────────────────────────────────

interface WithdrawBalances {
  safe: number;
  deposited: number;
}

async function getWithdrawBalances(walletAddress: string): Promise<WithdrawBalances> {
  const state = await getTraderState(walletAddress);
  return {
    safe: Math.max(0, Number(state.effectiveCollateral)),
    deposited: Math.max(0, Number(state.depositedCollateral)),
  };
}

// ─── Screens ──────────────────────────────────────────────────────────────────

export async function sendWithdrawDestScreen(ctx: BotContext, edit = false): Promise<void> {
  if (!ctx.user) return;

  const { safe, deposited } = await getWithdrawBalances(ctx.user.walletAddress);

  if (deposited < MIN_WITHDRAW_USD) {
    const kb = new InlineKeyboard().text("📥 Deposit USDC", "nav:deposit");
    await ctx.reply("Nothing to withdraw — your trading account is empty.", { reply_markup: kb });
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

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

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

export async function sendWithdrawAddrStep(ctx: BotContext, amount: number): Promise<void> {
  if (!ctx.user || !ctx.from) return;

  const kb = new InlineKeyboard().text("✕ Cancel", "cancel");
  const msg = fmt`📤 ${FormattedString.b("External Withdrawal — Step 2 of 3")}

Amount: ${FormattedString.b(usd(amount))}

Enter the ${FormattedString.b("destination Solana wallet address")}:
(must be a standard Solana address that can hold USDC)`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  await clearPending(ctx.from.id);
  await setPending(ctx.from.id, `withdraw_ext_addr:${amount.toFixed(2)}`);
}

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
    await ctx.reply(`You only have ${usd(deposited)} in your trading account.`);
    return;
  }

  const solConn = new Connection(config.HELIUS_RPC_URL, "confirmed");
  const lamports = await solConn.getBalance(new PublicKey(ctx.user.walletAddress));
  if (lamports < MIN_SOL_FOR_GAS) {
    const solBal = (lamports / 1e9).toFixed(4);
    await ctx.reply(
      `Not enough SOL for gas (have ${solBal} SOL, need ~0.001).\n\nSend a small amount of SOL to your bot wallet first:\n${ctx.user.walletAddress}`,
    );
    return;
  }

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

// ─── Register ─────────────────────────────────────────────────────────────────

export function registerWithdraw(bot: Bot<BotContext>) {
  bot.command("withdraw", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }
    if (!(await requireActivation(ctx))) return;
    await sendWithdrawDestScreen(ctx);
  });

  bot.callbackQuery("wd:dest", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    // edit=true replaces the current amount screen instead of appending a new message
    await sendWithdrawDestScreen(ctx, true);
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

  bot.callbackQuery("wd:custom:int", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    const { safe, deposited } = await getWithdrawBalances(ctx.user.walletAddress);
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
    const { safe, deposited } = await getWithdrawBalances(ctx.user.walletAddress);
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, "withdraw_custom:external");
    const msg = fmt`Enter the amount to withdraw (USD):\nSafe: ${FormattedString.code(usd(safe))}  Max: ${FormattedString.code(usd(deposited))}`;
    await ctx.reply(msg.text, {
      entities: msg.entities,
      reply_markup: new InlineKeyboard().text("✕ Cancel", "cancel"),
    });
  });

  // ── Execute: internal ──────────────────────────────────────────────────────

  bot.callbackQuery(/^wd:exec:int:([\d.]+)$/, async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery();
      return;
    }

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
    if (!chatId || !msgId) return;
    const api = ctx.api;

    void (async () => {
      try {
        const sig = await withdrawCollateral(user.walletAddress, amountNative);

        const msg = fmt`✅ ${FormattedString.b("Withdrawal complete")}

${FormattedString.b(usd(amount))} USDC is now in your bot wallet.

${FormattedString.link("View on Solscan →", solscanUrl(sig))}

Use /deposit to re-add it for trading, or send it to an external wallet from your Privy wallet.`;

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

  // ── Execute: external ──────────────────────────────────────────────────────

  bot.callbackQuery("wd:exec:ext", async (ctx) => {
    if (!ctx.user || !ctx.from) {
      await ctx.answerCallbackQuery();
      return;
    }

    const confirm = await consumeExtConfirm(String(ctx.from.id));
    if (!confirm) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Session expired. Start again with /withdraw.");
      return;
    }

    const lockKey = `wd:lock:ext:${ctx.user.id}`;
    const locked = await redis.set(lockKey, "1", "EX", EXEC_LOCK_TTL, "NX");
    if (!locked) {
      await storeExtConfirm(String(ctx.from.id), confirm.amount, confirm.toAddress);
      await ctx.answerCallbackQuery({ text: "Already processing…", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery("Processing…");
    await ctx.editMessageText("⏳ Processing external withdrawal…");

    const user = ctx.user;
    const fromId = String(ctx.from.id);
    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !msgId) return;
    const api = ctx.api;

    const { amount, toAddress } = confirm;
    const amountNative = BigInt(Math.round(amount * 1_000_000));

    void (async () => {
      let sig1: string;
      try {
        sig1 = await withdrawCollateral(user.walletAddress, amountNative);
      } catch (err) {
        logger.error({ err, amount, toAddress }, "External withdraw step 1 failed");
        await redis.del(lockKey);
        await storeExtConfirm(fromId, amount, toAddress);
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
        await api.editMessageText(chatId, msgId, "⏳ Step 1 done — moving funds to your address…");
      } catch {
        /* best effort */
      }

      const actualBalance = await getUsdcAtaBalanceNative(user.walletAddress);
      const transferAmount = actualBalance < amountNative ? actualBalance : amountNative;

      let sig2: string;
      try {
        sig2 = await transferUsdc(user.walletAddress, toAddress, transferAmount);
      } catch (err) {
        logger.error({ err, amount, toAddress }, "External withdraw step 2 failed");
        const recoveryMsg = fmt`⚠️ ${FormattedString.b("Partial failure")}

${FormattedString.b(usd(amount))} USDC reached your bot wallet (step 1 ✅) but the transfer to your address failed.

Your funds are safe. Use /withdraw → ${FormattedString.b("To bot wallet")} is no longer needed — funds are already in your bot wallet.
Use /deposit to re-add to trading, or retry the external send from /withdraw.

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
        return;
      }

      const displayAmount = Number(transferAmount) / 1_000_000;
      const msg = fmt`✅ ${FormattedString.b("External withdrawal complete")}

${FormattedString.b(usd(displayAmount))} USDC sent to:
${FormattedString.code(toAddress)}

${FormattedString.link("Step 1 (Phoenix → bot wallet) →", solscanUrl(sig1))}
${FormattedString.link("Step 2 (bot wallet → you) →", solscanUrl(sig2))}`;

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

export { sendWithdrawDestScreen as sendWithdrawAmountPrompt };
