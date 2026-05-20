import QRCode from "qrcode";
import { InputFile, type Bot } from "grammy";
import type { BotContext } from "../../types/index.js";

const WALLET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function registerDeposit(bot: Bot<BotContext>) {
  bot.command("deposit", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const { walletAddress } = ctx.user;
    const qr = await QRCode.toBuffer(walletAddress, { type: "png", width: 256 });

    await ctx.replyWithPhoto(new InputFile(qr, "deposit-qr.png"), {
      caption: [
        `📥 <b>Deposit</b>`,
        ``,
        `Send <b>SOL</b> (for gas) and <b>USDC</b> to:`,
        `<code>${walletAddress}</code>`,
        ``,
        `USDC mint: <code>${WALLET_USDC_MINT}</code>`,
        ``,
        `Deposits are processed via Ember (1:1 wrap) and credited to your Phoenix account automatically.`,
      ].join("\n"),
      parse_mode: "HTML",
    });
  });
}
