import type { Bot } from "grammy";
import { db } from "../../db/index.js";
import { alertSubscriptions } from "../../db/schema/index.js";
import type { BotContext } from "../../types/index.js";

export function registerPriceAlert(bot: Bot<BotContext>) {
  bot.command("alert", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const parts = ctx.match?.trim().split(" ");
    if (!parts || parts.length < 2) {
      await ctx.reply(
        "Usage:\n/alert SOL 200     — alert when ≥ $200\n/alert SOL -150    — alert when ≤ $150",
      );
      return;
    }

    const symbol = parts[0].toUpperCase();
    const price = Number(parts[1]);

    if (Number.isNaN(price)) {
      await ctx.reply("Invalid price.");
      return;
    }

    await db.insert(alertSubscriptions).values({
      id: crypto.randomUUID(),
      userId: ctx.user.id,
      type: "price",
      symbol,
      triggerPrice: String(price),
      enabled: true,
    });

    const direction = price > 0 ? `≥ $${price}` : `≤ $${Math.abs(price)}`;
    await ctx.reply(`🔔 Alert set: <b>${symbol}</b> ${direction}`, { parse_mode: "HTML" });
  });
}
