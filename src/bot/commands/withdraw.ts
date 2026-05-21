import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { getKitSigner } from "../../services/wallet.js";
import { withdrawCollateral } from "../../services/phoenix/trade.js";
import { redis } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";
import type { BotContext } from "../../types/index.js";

const SECURITY_DELAY_SECONDS = 300;

export function registerWithdraw(bot: Bot<BotContext>) {
  bot.command("withdraw", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const args = ctx.match?.trim().split(" ");
    if (!args || args.length < 1 || !args[0]) {
      await ctx.reply("Usage: /withdraw <amount>\nExample: /withdraw 100\n\nFunds are returned to your linked wallet.");
      return;
    }

    const amount = Number(args[0]);

    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount.");
      return;
    }

    const kb = new InlineKeyboard()
      .text("✅ Confirm", `withdraw:confirm:${amount}`)
      .text("❌ Cancel", "cancel");

    await ctx.reply(
      [
        `⚠️ <b>Confirm Withdrawal</b>`,
        ``,
        `Amount: <code>${amount} USDC</code>`,
        `To: <code>${ctx.user.walletAddress}</code>`,
        ``,
        `Note: Phoenix processes withdrawals via a global queue. Large withdrawals may take time. You'll be notified when complete.`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^withdraw:confirm:([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Processing...");
    if (!ctx.user) return;

    const amount = Number(ctx.match[1]);

    // Two-step security: first click records a timestamp; second click (after delay) executes.
    const pendingKey = `withdraw:pending:${ctx.user.id}`;
    const pendingTs = await redis.get(pendingKey);
    if (!pendingTs) {
      await redis.set(pendingKey, String(Date.now()), "EX", SECURITY_DELAY_SECONDS + 60);
      await ctx.editMessageText(
        [
          `⏳ <b>Withdrawal pending — security delay</b>`,
          ``,
          `For security, please wait <b>${SECURITY_DELAY_SECONDS / 60} minutes</b> then tap Confirm again.`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    const elapsed = (Date.now() - Number(pendingTs)) / 1000;
    if (elapsed < SECURITY_DELAY_SECONDS) {
      const remaining = Math.ceil(SECURITY_DELAY_SECONDS - elapsed);
      await ctx.answerCallbackQuery({ text: `Please wait ${remaining}s more before confirming.`, show_alert: true });
      return;
    }

    await redis.del(pendingKey);

    try {
      const amountNative = BigInt(Math.round(amount * 1_000_000));
      const sig = await withdrawCollateral(
        ctx.user.walletAddress,
        amountNative,
        getKitSigner(ctx.user.walletAddress),
      );

      await ctx.editMessageText(
        [
          `✅ <b>Withdrawal submitted</b>`,
          `Amount: <code>${amount} USDC</code>`,
          `To: <code>${ctx.user.walletAddress}</code>`,
          `Tx: <code>${sig}</code>`,
          ``,
          `Note: Funds may take a few minutes if the Phoenix withdrawal queue is busy.`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error({ err }, "Withdrawal failed");
      await ctx.editMessageText("❌ Withdrawal failed. Check your balance and try again.");
    }
  });
}
