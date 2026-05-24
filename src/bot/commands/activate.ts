import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";

const INVITE_SEARCH_URL = "https://x.com/search?q=%23PhoenixPerp+invite";
import { config } from "../../config/index.js";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/index.js";
import type { BotContext } from "../../types/index.js";

async function phoenixPost(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${config.PHOENIX_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tryActivate(walletAddress: string, code: string): Promise<boolean> {
  const inviteRes = await phoenixPost("/v1/invite/activate", { authority: walletAddress, code });
  if (inviteRes.ok) return true;
  // 5xx = server error, don't silently retry with the other endpoint
  if (inviteRes.status >= 500) throw new Error(`Phoenix activation error: ${inviteRes.status}`);

  const referralRes = await phoenixPost("/v1/invite/activate-with-referral", {
    authority: walletAddress,
    referral_code: code,
  });
  return referralRes.ok;
}

export function registerActivate(bot: Bot<BotContext>) {
  bot.command("activate", async (ctx) => {
    if (!ctx.from) return;

    if (!ctx.user) {
      await ctx.reply("Please use /start first to create your wallet.");
      return;
    }

    if (ctx.user.phoenixActivated) {
      await ctx.reply("✅ Your account is already activated. You can trade with /long or /short.");
      return;
    }

    const code = ctx.match?.trim();
    if (!code) {
      await sendActivatePrompt(ctx);
      return;
    }

    const processing = await ctx.reply("Activating account... ⏳");
    const chatId = ctx.chat?.id;
    const msgId = processing.message_id;

    try {
      const activated = await tryActivate(ctx.user.walletAddress, code);

      if (!activated) {
        await ctx.api.editMessageText(
          chatId,
          msgId,
          "❌ Invalid code. Check the code and try again.",
        );
        return;
      }

      await db
        .update(users)
        .set({ phoenixActivated: true, updatedAt: new Date() })
        .where(eq(users.telegramId, String(ctx.from.id)));

      const kb = new InlineKeyboard()
        .text("🟢 Long", "nav:long")
        .text("🔴 Short", "nav:short")
        .row()
        .text("💰 Deposit", "nav:deposit")
        .text("📈 Markets", "nav:markets");

      const msg = fmt`✅ ${FormattedString.b("Account Activated!")}\n\nYou can now trade on Phoenix.\nDeposit USDC with /deposit to get started.`;
      await ctx.api.editMessageText(chatId, msgId, msg.text, {
        entities: msg.entities,
        reply_markup: kb,
      });
    } catch (err) {
      await ctx.api.editMessageText(chatId, msgId, "❌ Activation failed. Please try again.");
      throw err;
    }
  });

  bot.callbackQuery("nav:activate", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (ctx.user.phoenixActivated) {
      await ctx.reply("✅ Already activated. Use /long or /short to trade.");
      return;
    }
    await sendActivatePrompt(ctx);
  });
}

async function sendActivatePrompt(ctx: BotContext): Promise<void> {
  const kb = new InlineKeyboard().url("Find an invite code on X →", INVITE_SEARCH_URL);
  const msg = fmt`🔑 ${FormattedString.b("Activate Trading")}\n\nYou need an ${FormattedString.b("invite code")} or ${FormattedString.b("access code")} to unlock trading.\n\n${FormattedString.b("Have a code?")} Send it now:\n${FormattedString.code("/activate <code>")}\n\n${FormattedString.b("No code?")} Ask an existing trader, or search for one on X.`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
