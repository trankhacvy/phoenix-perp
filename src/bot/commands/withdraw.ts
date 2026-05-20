import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { getWalletSigner } from "../../services/wallet.js";
import { createTradingClient } from "../../services/phoenix/client.js";
import { logger } from "../../lib/logger.js";
import type { BotContext } from "../../types/index.js";

const FIRST_ADDRESS_DELAY_SECONDS = 300;

export function registerWithdraw(bot: Bot<BotContext>) {
  bot.command("withdraw", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const args = ctx.match?.trim().split(" ");
    if (!args || args.length < 2) {
      await ctx.reply("Usage: /withdraw <amount> <address>\nExample: /withdraw 100 ABC...XYZ");
      return;
    }

    const [amountStr, address] = args;
    const amount = Number(amountStr);

    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount.");
      return;
    }

    const kb = new InlineKeyboard()
      .text("✅ Confirm", `withdraw:confirm:${amount}:${address}`)
      .text("❌ Cancel", "cancel");

    await ctx.reply(
      [
        `⚠️ <b>Confirm Withdrawal</b>`,
        ``,
        `Amount: <code>${amount} USDC</code>`,
        `To: <code>${address}</code>`,
        ``,
        `Note: Phoenix processes withdrawals via a global queue. Large withdrawals may take time. You'll be notified when complete.`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^withdraw:confirm:([\d.]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Processing...");
    if (!ctx.user) return;

    const amount = Number(ctx.match[1]);
    const toAddress = ctx.match[2];

    const seenKey = `withdraw:seen:${ctx.user.id}:${toAddress}`;
    const seen = await import("../../lib/redis.js").then((m) => m.redis.get(seenKey));
    if (!seen) {
      await import("../../lib/redis.js").then((m) =>
        m.redis.set(seenKey, "1", "EX", FIRST_ADDRESS_DELAY_SECONDS),
      );
      await ctx.editMessageText(
        [
          `⏳ <b>New destination address detected</b>`,
          ``,
          `For security, first-time withdrawals to a new address have a ${FIRST_ADDRESS_DELAY_SECONDS / 60}-minute delay.`,
          `Please confirm again after the delay.`,
          ``,
          `Address: <code>${toAddress}</code>`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    try {
      const signer = getWalletSigner(ctx.user.walletAddress);
      const client = await createTradingClient(signer);

      const ix = await client.ixs.withdrawCollateral({
        amountUsdc: amount,
        destinationAddress: toAddress,
      });
      const sig = await client.sendAndConfirm(ix);

      await ctx.editMessageText(
        [
          `✅ <b>Withdrawal submitted</b>`,
          `Amount: <code>${amount} USDC</code>`,
          `To: <code>${toAddress}</code>`,
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
