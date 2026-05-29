import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { type Bot, InputFile } from "grammy";
import QRCode from "qrcode";
import { getReferralStats } from "../../services/referral.js";
import type { BotContext } from "../../types/index.js";
import { num } from "../lib/fmt.js";
import { referralLink } from "../lib/referral-link.js";

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
    const link = referralLink(ctx) ?? "";

    const rankLine = stats.rank
      ? fmt`🏆 Rank             ${FormattedString.b(`#${stats.rank}`)} ${FormattedString.i(`of ${num(stats.totalReferrers)}`)}`
      : fmt`🏆 Rank             ${FormattedString.i("unranked — refer to climb")}`;

    const caption = fmt`👥 ${FormattedString.b("Your Referral")}

Share your link. When friends trade, you earn ${FormattedString.b("points")} — ${FormattedString.b("1 point per $1")} of their volume.

⭐ Points           ${FormattedString.b(num(stats.points))}
👤 Referrals        ${FormattedString.b(num(stats.referralCount))}
${rankLine}

🔗 ${FormattedString.code(link)}
Code: ${FormattedString.code(ctx.user.referralCode)}

${FormattedString.i("Points count toward future rewards. Tap the link or code to copy.")}`;

    const qr = await QRCode.toBuffer(link, { type: "png", width: 320, margin: 2 });
    await ctx.replyWithPhoto(new InputFile(qr, "referral-qr.png"), {
      caption: caption.caption,
      caption_entities: caption.caption_entities,
    });
  });
}
