import { Bot, webhookCallback } from "grammy";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { addMargin, setTpSl } from "../services/phoenix/trade.js";
import { getKitSigner } from "../services/wallet.js";
import type { BotContext } from "../types/index.js";
import { registerCommands } from "./commands/index.js";
import { authMiddleware } from "./middleware/auth.js";
import { orderRateLimitMiddleware, rateLimitMiddleware } from "./middleware/rate-limit.js";

export const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);

bot.use(authMiddleware);
bot.use(rateLimitMiddleware);

bot.command("long", orderRateLimitMiddleware);
bot.command("short", orderRateLimitMiddleware);

registerCommands(bot);

bot.on("message:text", async (ctx) => {
  if (!ctx.user) return;

  const pendingKey = `pending:${ctx.from.id}`;
  const pending = await redis.get(pendingKey);
  if (!pending) return;

  await redis.del(pendingKey);

  const parts = pending.split(":");
  const action = parts[0];
  const symbol = parts[1];
  const positionSide: "long" | "short" = parts[2] === "short" ? "short" : "long";
  const value = Number(ctx.message.text.trim());

  if (Number.isNaN(value) || value <= 0) {
    await ctx.reply("Invalid value. Action cancelled.");
    return;
  }

  try {
    const signer = getKitSigner(ctx.user.walletAddress);
    if (action === "addmargin") {
      await addMargin(symbol, ctx.user.walletAddress, value, signer);
      await ctx.reply(`✅ Added $${value} USDC margin to ${symbol}.`);
    } else if (action === "editsl") {
      await setTpSl({ symbol, walletAddress: ctx.user.walletAddress, positionSide, slPrice: value }, signer);
      await ctx.reply(`✅ Stop-loss for ${symbol} set to $${value}.`);
    } else if (action === "edittp") {
      await setTpSl({ symbol, walletAddress: ctx.user.walletAddress, positionSide, tpPrice: value }, signer);
      await ctx.reply(`✅ Take-profit for ${symbol} set to $${value}.`);
    }
  } catch {
    await ctx.reply("❌ Failed. Please try again.");
  }
});

bot.catch(async (err) => {
  logger.error({ err: err.error, update: err.ctx.update }, "Bot error");
  try {
    await err.ctx.reply("Something went wrong. Please try again.");
  } catch {
    // ctx may be invalid (e.g. callback query already answered)
  }
});

export function handleWebhook() {
  return webhookCallback(bot, "fastify");
}
