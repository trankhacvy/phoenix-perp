import type { Bot } from "grammy";
import { getReferralStats } from "../../services/referral.js";
import type { BotContext } from "../../types/index.js";

export function registerReferral(bot: Bot<BotContext>) {
  bot.command("referral", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    if (!ctx.user.referralCode) {
      await ctx.reply("Referral code not set up. Try again or contact support.");
      return;
    }

    const stats = await getReferralStats(ctx.user.id);
    const botInfo = await bot.api.getMe();
    const link = `https://t.me/${botInfo.username}?start=${ctx.user.referralCode}`;

    await ctx.reply(
      [
        `👥 <b>Your Referral</b>`,
        ``,
        `Link: ${link}`,
        `Code: <code>${ctx.user.referralCode}</code>`,
        ``,
        `T1 referrals: <b>${stats.t1Count}</b>`,
        `T2 referrals: <b>${stats.t2Count}</b>`,
        ``,
        `Accrued rebate: <code>${stats.totalAccruedUsdc.toFixed(6)} USDC</code>`,
        `Claimable: <code>${stats.claimableUsdc.toFixed(6)} USDC</code>`,
        ``,
        `Use /claim to withdraw your rebate.`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });
}
