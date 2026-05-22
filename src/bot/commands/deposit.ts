import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { type Bot, InlineKeyboard, InputFile } from "grammy";
import QRCode from "qrcode";
import type { BotContext } from "../../types/index.js";

export function registerDeposit(bot: Bot<BotContext>) {
  bot.command("deposit", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    await sendDepositScreen(ctx);
  });
}

export async function sendDepositScreen(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const { walletAddress } = ctx.user;
  const qr = await QRCode.toBuffer(walletAddress, { type: "png", width: 256 });
  const kb = new InlineKeyboard().text("← Back", "nav:balance");

  const msg = fmt`📥 ${FormattedString.b("Add Funds")}\n\nSend ${FormattedString.b("USDC")} to your wallet:\n${FormattedString.code(walletAddress)}\n\nOnly send standard USDC (${FormattedString.code("EPjF...Dt1v")}).\nAlso send ${FormattedString.b("≈0.01 SOL")} to cover transaction fees.\n\nFunds arrive automatically — no extra steps needed.`;

  await ctx.replyWithPhoto(new InputFile(qr, "deposit-qr.png"), {
    caption: msg.caption,
    caption_entities: msg.caption_entities,
    reply_markup: kb,
  });
}
