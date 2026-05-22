import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import { db } from "../../db/index.js";
import { referrals } from "../../db/schema/index.js";
import { getClaimableReferrals } from "../../services/referral.js";
import type { BotContext } from "../../types/index.js";

export function registerClaim(bot: Bot<BotContext>) {
  bot.command("claim", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const rows = await getClaimableReferrals(ctx.user.id);
    const claimable = rows.reduce(
      (sum, r) => sum + Number(r.accruedUsdc) - Number(r.claimedUsdc),
      0,
    );

    if (claimable < 1) {
      await ctx.reply(
        "No claimable rebate yet (minimum $1 USDC).\n\nKeep referring users to earn! Use /referral to see your stats.",
      );
      return;
    }

    await Promise.all(
      rows.map((r) =>
        db
          .update(referrals)
          .set({ claimedUsdc: r.accruedUsdc, updatedAt: new Date() })
          .where(eq(referrals.id, r.id)),
      ),
    );

    const msg = fmt`✅ Claimed ${FormattedString.code(`${claimable.toFixed(6)} USDC`)} referral rebate.\n\nFunds will arrive in your wallet within 24 hours.`;
    await ctx.reply(msg.text, { entities: msg.entities });
  });
}
