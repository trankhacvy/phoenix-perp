import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import type { BotContext } from "../../types/index.js";

export function registerExport(bot: Bot<BotContext>) {
  bot.command("export", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const kb = new InlineKeyboard()
      .text("⚠️ I understand — show key", "export:confirm")
      .row()
      .text("Cancel", "cancel");

    const msg = fmt`🔐 ${FormattedString.b("Export Private Key")}\n\n⚠️ ${FormattedString.b("DANGER:")} Anyone with your private key can steal all funds.\nNever share it. Store it offline.\n\nThis bot uses a server-custodial wallet via Privy.\nKey export is available through the Privy dashboard:\n${FormattedString.b("https://dashboard.privy.io")}`;

    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery("export:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;

    const msg = fmt`🔐 ${FormattedString.b("Export Private Key")}\n\nPrivate key export requires direct Privy dashboard access.\n\n1. Go to ${FormattedString.b("https://dashboard.privy.io")}\n2. Sign in with your operator credentials\n3. Find your wallet: ${FormattedString.code(ctx.user.walletAddress)}\n4. Use the export function in the dashboard\n\n${FormattedString.i("Server-side key export is not available for security reasons.")}`;

    await ctx.editMessageText(msg.text, { entities: msg.entities });
  });
}
