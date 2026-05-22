import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import { getKitSigner } from "../../services/wallet.js";
import { withdrawCollateral } from "../../services/phoenix/trade.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { redis } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";
import { parseAmount, usd, shortAddr, solscanUrl } from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";
import type { BotContext } from "../../types/index.js";

const SECURITY_DELAY_SECONDS = 300;

export function registerWithdraw(bot: Bot<BotContext>) {
  bot.command("withdraw", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    const raw = ctx.match?.trim();
    if (!raw) {
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

  bot.callbackQuery(/^withdraw:confirm:([\d.]+)$/, async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery();
      return;
    }

    const amount = Number(ctx.match[1]);
    const pendingKey = `withdraw:pending:${ctx.user.id}`;
    const pendingTs = await redis.get(pendingKey);

    if (!pendingTs) {
      await ctx.answerCallbackQuery();
      await redis.set(pendingKey, String(Date.now()), "EX", SECURITY_DELAY_SECONDS + 60);
      const kb = new InlineKeyboard().text("✕ Cancel withdrawal", "withdraw:cancel");
      const msg = fmt`🔒 ${FormattedString.b("Withdrawal pending")}\n\n${usd(amount)} USDC\n\nConfirm again in ${FormattedString.b("5 minutes")} to complete.\nTap confirm again: /withdraw ${amount}`;
      await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
      return;
    }

    const elapsed = (Date.now() - Number(pendingTs)) / 1000;
    if (elapsed < SECURITY_DELAY_SECONDS) {
      const remaining = Math.ceil(SECURITY_DELAY_SECONDS - elapsed);
      await ctx.answerCallbackQuery({ text: `Wait ${remaining}s more.`, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery("Processing...");
    await redis.del(pendingKey);

    try {
      const amountNative = BigInt(Math.round(amount * 1_000_000));
      const sig = await withdrawCollateral(
        ctx.user.walletAddress,
        amountNative,
        getKitSigner(ctx.user.walletAddress),
      );
      const msg = fmt`✅ ${FormattedString.b("Withdrawal submitted")}\n\n${FormattedString.b(usd(amount))} sent to your wallet.\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}\n\nLarge withdrawals may take a few minutes due to the on-chain queue.`;
      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error({ err }, "Withdrawal failed");
      await ctx.editMessageText(
        "❌ Withdrawal failed. Check your balance with /balance and try again.",
      );
    }
  });

  bot.callbackQuery("withdraw:cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    if (ctx.user) {
      await redis.del(`withdraw:pending:${ctx.user.id}`);
    }
    await ctx.editMessageText("✕ Withdrawal cancelled.");
  });
}

export async function sendWithdrawAmountPrompt(ctx: BotContext): Promise<void> {
  const state = await getTraderState(ctx.user!.walletAddress);
  const available = Number(state.effectiveCollateral);

  const msg = fmt`📤 ${FormattedString.b("Withdraw Funds")}\n\nAvailable: ${FormattedString.code(usd(available))}\n\nReply with the amount you want to withdraw:`;
  await ctx.reply(msg.text, { entities: msg.entities });
  await setPending(ctx.from!.id, "withdraw_amount");
}

export async function sendWithdrawConfirm(ctx: BotContext, amount: number): Promise<void> {
  const state = await getTraderState(ctx.user!.walletAddress);
  const available = Number(state.effectiveCollateral);

  if (amount < 1) {
    await ctx.reply("Minimum withdrawal is $1.00.");
    return;
  }
  if (amount > available) {
    await ctx.reply(`You only have ${usd(available)} available. Enter a smaller amount.`);
    return;
  }

  const kb = new InlineKeyboard()
    .text("✅ Start withdrawal", `withdraw:confirm:${amount}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`📤 ${FormattedString.b(`Withdraw ${usd(amount)}`)}\n\nTo: ${FormattedString.code(shortAddr(ctx.user!.walletAddress))}\n\n⚠️ For security, you'll need to confirm again after 5 minutes.`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
