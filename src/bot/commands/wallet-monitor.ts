import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { and, eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "../../db/index.js";
import { walletMonitors } from "../../db/schema/index.js";
import { MONITOR_EVENTS_CHANNEL } from "../../lib/constants.js";
import { redis } from "../../lib/redis.js";
import type { BotContext } from "../../types/index.js";
import { shortAddr } from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";
import { BASE58_RE } from "../lib/validate.js";

const MAX_MONITORS = 10;

async function sendMonitorList(ctx: BotContext, edit = false): Promise<void> {
  if (!ctx.user) return;

  const rows = await db
    .select()
    .from(walletMonitors)
    .where(and(eq(walletMonitors.userId, ctx.user.id), eq(walletMonitors.enabled, true)));

  if (rows.length === 0) {
    const msg = fmt`👁 ${FormattedString.b("Wallet Monitor")}\n\nNo wallets monitored yet.\n\nUse ${FormattedString.code("/monitor <address>")} to start.`;
    const kb = new InlineKeyboard().text("+ Add wallet", "monitor:prompt_add");
    const opts = { entities: msg.entities, reply_markup: kb };
    if (edit && ctx.callbackQuery) await ctx.editMessageText(msg.text, opts);
    else await ctx.reply(msg.text, opts);
    return;
  }

  const lines = rows.map((r, i) => {
    const name = r.label ?? shortAddr(r.watchedWallet);
    return fmt`${i + 1}. ${FormattedString.b(name)}  ${FormattedString.code(shortAddr(r.watchedWallet))}`;
  });

  const header = fmt`👁 ${FormattedString.b("Monitored Wallets")}`;
  const msg = FormattedString.join([header, "", ...lines], "\n");

  const kb = new InlineKeyboard();
  for (const r of rows) {
    const name = r.label ?? shortAddr(r.watchedWallet);
    kb.text(`🗑 ${name}`, `monitor:rm:${r.id}`).row();
  }
  kb.text("+ Add wallet", "monitor:prompt_add");

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) await ctx.editMessageText(msg.text, opts);
  else await ctx.reply(msg.text, opts);
}

export async function handleAddMonitor(ctx: BotContext, walletAddress: string): Promise<void> {
  if (!ctx.user) return;

  if (walletAddress === ctx.user.walletAddress) {
    await ctx.reply("That's your own wallet — you already get alerts for it.");
    return;
  }

  const existing = await db
    .select({ id: walletMonitors.id })
    .from(walletMonitors)
    .where(and(eq(walletMonitors.userId, ctx.user.id), eq(walletMonitors.enabled, true)));

  if (existing.length >= MAX_MONITORS) {
    await ctx.reply(
      `You can monitor up to ${MAX_MONITORS} wallets. Remove one first with /monitor.`,
    );
    return;
  }

  await db
    .insert(walletMonitors)
    .values({
      id: crypto.randomUUID(),
      userId: ctx.user.id,
      watchedWallet: walletAddress,
      alertOnFill: true,
      alertOnPositionChange: true,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [walletMonitors.userId, walletMonitors.watchedWallet],
      set: { enabled: true },
    });

  await redis.publish(
    MONITOR_EVENTS_CHANNEL,
    JSON.stringify({ action: "subscribe", wallet: walletAddress, telegramId: ctx.user.telegramId }),
  );

  const msg = fmt`✅ Now monitoring ${FormattedString.code(shortAddr(walletAddress))}\n\nYou'll get alerts when this wallet opens, closes, or fills a position.`;
  const kb = new InlineKeyboard().text("← My monitors", "monitor:list");
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function handleRemoveMonitor(ctx: BotContext, monitorId: string): Promise<void> {
  if (!ctx.user) return;

  const [removed] = await db
    .update(walletMonitors)
    .set({ enabled: false })
    .where(and(eq(walletMonitors.id, monitorId), eq(walletMonitors.userId, ctx.user.id)))
    .returning();

  if (!removed) {
    await ctx.answerCallbackQuery("Not found.");
    return;
  }

  await redis.publish(
    MONITOR_EVENTS_CHANNEL,
    JSON.stringify({
      action: "unsubscribe",
      wallet: removed.watchedWallet,
      telegramId: ctx.user.telegramId,
    }),
  );

  await ctx.answerCallbackQuery("Removed.");
  await sendMonitorList(ctx, true);
}

export function registerWalletMonitor(bot: Bot<BotContext>) {
  bot.command("monitor", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }

    const arg = ctx.match?.trim();
    if (!arg) {
      await sendMonitorList(ctx);
      return;
    }

    if (!BASE58_RE.test(arg)) {
      await ctx.reply("Invalid wallet address. Send a valid Solana address.");
      return;
    }

    await handleAddMonitor(ctx, arg);
  });

  bot.callbackQuery("monitor:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendMonitorList(ctx, true);
  });

  bot.callbackQuery("monitor:prompt_add", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const msg = fmt`Send the Solana wallet address you want to monitor:`;
    await ctx.reply(msg.text, { entities: msg.entities });
    await setPending(ctx.from.id, "monitor_add");
  });

  bot.callbackQuery(/^monitor:add:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await handleAddMonitor(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^monitor:rm:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await handleRemoveMonitor(ctx, ctx.match[1]);
  });
}
