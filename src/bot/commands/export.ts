import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
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

    await ctx.reply(
      [
        `🔐 <b>Export Private Key</b>`,
        ``,
        `⚠️ <b>DANGER:</b> Anyone with your private key can steal all funds.`,
        `Never share it. Store it offline.`,
        ``,
        `This bot uses a server-custodial wallet via Privy.`,
        `Key export is available through the Privy dashboard:`,
        `<b>https://dashboard.privy.io</b>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery("export:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;

    await ctx.editMessageText(
      [
        `🔐 <b>Export Private Key</b>`,
        ``,
        `Private key export requires direct Privy dashboard access.`,
        ``,
        `1. Go to <b>https://dashboard.privy.io</b>`,
        `2. Sign in with your operator credentials`,
        `3. Find your wallet: <code>${ctx.user.walletAddress}</code>`,
        `4. Use the export function in the dashboard`,
        ``,
        `<i>Server-side key export is not available for security reasons.</i>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });
}
