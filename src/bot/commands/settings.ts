import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/index.js";
import type { BotContext } from "../../types/index.js";

type Settings = { slippageBps: number; defaultLeverage: number };

async function getSettings(userId: string): Promise<Settings> {
  return (
    (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) })) ?? {
      slippageBps: 50,
      defaultLeverage: 5,
    }
  );
}

async function saveSettings(userId: string, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(userId);
  const next = { ...current, ...patch };
  await db
    .insert(userSettings)
    .values({ userId, ...next })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ...patch, updatedAt: new Date() },
    });
  return next;
}

function settingsMsg(s: Settings): FormattedString {
  return fmt`⚙️ ${FormattedString.b("Settings")}\n\nSlippage tolerance  ${FormattedString.code(`${s.slippageBps / 100}%`)}\nDefault leverage    ${FormattedString.code(`${s.defaultLeverage}x`)}`;
}

function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Change slippage", "settings:slippage")
    .row()
    .text("Change default leverage", "settings:leverage")
    .row()
    .text("🔔 Manage alerts", "nav:alerts");
}

const SLIPPAGE_OPTIONS = [
  { label: "0.1%", bps: 10 },
  { label: "0.3%", bps: 30 },
  { label: "0.5%", bps: 50 },
  { label: "1.0%", bps: 100 },
  { label: "2.0%", bps: 200 },
];

const LEVERAGE_OPTIONS = [2, 5, 10, 25, 50];

export function registerSettings(bot: Bot<BotContext>) {
  bot.command("settings", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    const s = await getSettings(ctx.user.id);
    const msg = settingsMsg(s);
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: settingsKeyboard() });
  });

  bot.callbackQuery("settings:slippage", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const opt of SLIPPAGE_OPTIONS) {
      const star = opt.bps === s.slippageBps ? " ★" : "";
      kb.text(`${opt.label}${star}`, `slip:${opt.bps}`);
    }
    kb.row().text("← Back", "settings:back");
    await ctx.editMessageText("Select slippage tolerance:", { reply_markup: kb });
  });

  bot.callbackQuery(/^slip:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    const bps = Number(ctx.match[1]);
    const s = await saveSettings(ctx.user.id, { slippageBps: bps });
    const msg = settingsMsg(s);
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: settingsKeyboard(),
    });
  });

  bot.callbackQuery("settings:leverage", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const lev of LEVERAGE_OPTIONS) {
      const star = lev === s.defaultLeverage ? " ★" : "";
      kb.text(`${lev}x${star}`, `deflev:${lev}`);
    }
    kb.row().text("← Back", "settings:back");
    await ctx.editMessageText("Select default leverage:", { reply_markup: kb });
  });

  bot.callbackQuery(/^deflev:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    const lev = Number(ctx.match[1]);
    const s = await saveSettings(ctx.user.id, { defaultLeverage: lev });
    const msg = settingsMsg(s);
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: settingsKeyboard(),
    });
  });

  bot.callbackQuery("settings:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const msg = settingsMsg(s);
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: settingsKeyboard(),
    });
  });
}
