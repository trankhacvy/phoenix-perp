import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/index.js";
import type { BotContext } from "../../types/index.js";

export function registerSettings(bot: Bot<BotContext>) {
  bot.command("settings", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }
    await showSettings(ctx);
  });

  async function showSettings(ctx: BotContext) {
    const settings = (await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, ctx.user!.id),
    })) ?? { slippageBps: 50, defaultLeverage: 5 };

    const kb = new InlineKeyboard()
      .text(`Slippage: ${settings.slippageBps / 100}%`, "settings:slippage")
      .row()
      .text(`Default leverage: ${settings.defaultLeverage}x`, "settings:leverage")
      .row()
      .text("Manage alerts →", "settings:alerts");

    await ctx.reply("<b>⚙️ Settings</b>", { parse_mode: "HTML", reply_markup: kb });
  }

  bot.callbackQuery("settings:slippage", async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text("0.1%", "slip:10")
      .text("0.3%", "slip:30")
      .text("0.5%", "slip:50")
      .row()
      .text("1%", "slip:100")
      .text("2%", "slip:200");
    await ctx.editMessageText("Select slippage tolerance:", { reply_markup: kb });
  });

  bot.callbackQuery(/^slip:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const bps = Number(ctx.match[1]);
    await db
      .insert(userSettings)
      .values({ userId: ctx.user.id, slippageBps: bps })
      .onConflictDoUpdate({ target: userSettings.userId, set: { slippageBps: bps, updatedAt: new Date() } });
    await ctx.editMessageText(`✅ Slippage set to ${bps / 100}%.`);
  });

  bot.callbackQuery("settings:leverage", async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text("2x", "lev:2")
      .text("5x", "lev:5")
      .text("10x", "lev:10")
      .text("25x", "lev:25");
    await ctx.editMessageText("Select default leverage:", { reply_markup: kb });
  });

  bot.callbackQuery(/^lev:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const lev = Number(ctx.match[1]);
    await db
      .insert(userSettings)
      .values({ userId: ctx.user.id, defaultLeverage: lev })
      .onConflictDoUpdate({ target: userSettings.userId, set: { defaultLeverage: lev, updatedAt: new Date() } });
    await ctx.editMessageText(`✅ Default leverage set to ${lev}x.`);
  });

  bot.callbackQuery("settings:alerts", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Use /alerts to manage alert settings.");
  });
}
