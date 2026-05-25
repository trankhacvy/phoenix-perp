import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { getReferralStats } from "../../services/referral.js";
import type { BotContext } from "../../types/index.js";

export function registerReferral(bot: Bot<BotContext>) {
  bot.command("referral", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }

    if (!ctx.user.referralCode) {
      await ctx.reply("Referral code not set up. Try again or contact support.");
      return;
    }

    const stats = await getReferralStats(ctx.user.id);
    const botInfo = await bot.api.getMe();
    const link = `https://t.me/${botInfo.username}?start=${ctx.user.referralCode}`;

    const msg = fmt`👥 ${FormattedString.b("Your Referral")}\n\nLink: ${link}\nCode: ${FormattedString.code(ctx.user.referralCode)}\n\nDirect referrals: ${FormattedString.b(String(stats.t1Count))}\nIndirect referrals: ${FormattedString.b(String(stats.t2Count))}\n\nAccrued rebate: ${FormattedString.code(`${stats.totalAccruedUsdc.toFixed(6)} USDC`)}\nClaimable: ${FormattedString.code(`${stats.claimableUsdc.toFixed(6)} USDC`)}\n\nUse /claim to withdraw your rebate.`;

    await ctx.reply(msg.text, {
      entities: msg.entities,
      link_preview_options: { is_disabled: true },
    });
  });
}
