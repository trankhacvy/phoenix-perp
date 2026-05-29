import { type Bot, InputFile } from "grammy";
import { logger } from "../../lib/logger.js";
import { generatePnlCard, generateWalletCard } from "../../services/image.js";
import type { BotContext } from "../../types/index.js";
import { referralBadgeData } from "../lib/referral-link.js";

/**
 * Dev/test command — renders sample share cards (PnL win, PnL loss, wallet
 * summary) with the referral QR badge so the image layout can be eyeballed.
 * Not listed in the command menu.
 */
export function registerTestCard(bot: Bot<BotContext>) {
  bot.command("testcard", async (ctx) => {
    await ctx.reply("Generating sample cards…");
    const referral = referralBadgeData(ctx);

    try {
      const win = await generatePnlCard({
        symbol: "SOL",
        side: "long",
        leverage: 10,
        entryPrice: "142.50",
        exitPrice: "168.90",
        roiPercent: 185.3,
        pnlUsdc: 1853.42,
        size: "12.5 SOL",
        referral,
      });
      await ctx.replyWithPhoto(new InputFile(win, "pnl-win.png"), { caption: "PnL card — win" });

      const loss = await generatePnlCard({
        symbol: "BTC",
        side: "short",
        leverage: 5,
        entryPrice: "64,200",
        exitPrice: "66,800",
        roiPercent: -20.2,
        pnlUsdc: -404.18,
        size: "0.15 BTC",
        referral,
      });
      await ctx.replyWithPhoto(new InputFile(loss, "pnl-loss.png"), { caption: "PnL card — loss" });

      const wallet = await generateWalletCard({
        walletAddress: ctx.user?.walletAddress ?? "So11111111111111111111111111111111111111112",
        realizedPnl: 12450.33,
        winRate: 63,
        totalFills: 284,
        totalVolume: 1_840_000,
        bestTrade: { pnl: 3200, symbol: "SOL" },
        worstTrade: { pnl: -1100, symbol: "ETH" },
        referral,
      });
      await ctx.replyWithPhoto(new InputFile(wallet, "wallet.png"), { caption: "Wallet card" });
    } catch (err) {
      logger.error({ err }, "testcard generation failed");
      await ctx.reply("Card generation failed — check logs.");
    }
  });
}
