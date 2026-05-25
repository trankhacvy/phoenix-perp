import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";
import { privy } from "../../lib/privy.js";
import { resolvePrivyWalletId } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { renderBotError } from "../lib/errors.js";

export function registerExport(bot: Bot<BotContext>) {
  // Only available in development — do not register in production.
  if (config.NODE_ENV !== "development") return;

  bot.command("exportkey", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }

    const kb = new InlineKeyboard()
      .text("⚠️ Yes, export my key", "exportkey:confirm")
      .row()
      .text("Cancel", "cancel");

    const msg = fmt`🔐 ${FormattedString.b("Export Private Key")}\n\n${FormattedString.b("⚠️ Development only.")}\n\nYour private key gives full control of your wallet. Back it up offline and never share it.\n\nContinue?`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery("exportkey:confirm", async (ctx) => {
    await ctx.answerCallbackQuery("Fetching key…");
    if (!ctx.user) return;

    try {
      const walletId = await resolvePrivyWalletId(ctx.user.walletAddress);

      const { private_key } = await privy.wallets().exportPrivateKey(walletId, {
        authorization_context: config.PRIVY_AUTHORIZATION_PRIVATE_KEY
          ? {
              authorization_private_keys: [config.PRIVY_AUTHORIZATION_PRIVATE_KEY],
            }
          : undefined,
      });

      await ctx.editMessageText(
        "✅ Key retrieved — check your next message. Delete it after saving.",
      );

      const keyMsg = fmt`🔑 ${FormattedString.b("Private Key (Solana / base58)")}\n\n${FormattedString.code(private_key)}\n\n${FormattedString.b("⚠️ Delete this message after backing up.")}`;
      await ctx.reply(keyMsg.text, { entities: keyMsg.entities });
    } catch (err) {
      logger.error({ err }, "exportkey failed");
      await renderBotError(ctx, err, {
        action: "Export private key",
        edit: true,
      });
    }
  });
}
