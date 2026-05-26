import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { and, eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "../../db/index.js";
import { leaderboardSnapshots, walletMonitors } from "../../db/schema/index.js";
import { MONITOR_EVENTS_CHANNEL } from "../../lib/constants.js";
import { redis } from "../../lib/redis.js";
import type { BotContext } from "../../types/index.js";
import { shortAddr } from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";
import { BASE58_RE } from "../lib/validate.js";

const MAX_MONITORS = 10;

interface MonitorRow {
  id: string;
  watchedWallet: string;
  label: string | null;
  alertOnFill: boolean;
  alertOnPositionChange: boolean;
}

async function resolveLabel(wallet: string, dbLabel: string | null): Promise<string> {
  if (dbLabel) return dbLabel;
  try {
    const snap = await db.query.leaderboardSnapshots.findFirst({
      where: eq(leaderboardSnapshots.walletAddress, wallet),
    });
    if (snap?.metadata) {
      const meta = snap.metadata as { name?: string };
      if (meta.name) return meta.name;
    }
  } catch {
    // ok
  }
  return shortAddr(wallet);
}

function watchingSummary(row: MonitorRow): string {
  const parts: string[] = [];
  if (row.alertOnPositionChange) parts.push("positions");
  if (row.alertOnFill) parts.push("fills");
  return parts.length > 0 ? parts.join(" · ") : "paused";
}

async function sendMonitorList(ctx: BotContext, edit = false) {
  if (!ctx.user) return;

  const rows = await db
    .select()
    .from(walletMonitors)
    .where(and(eq(walletMonitors.userId, ctx.user.id), eq(walletMonitors.enabled, true)));

  if (rows.length === 0) {
    const msg = fmt`👁 ${FormattedString.b("Wallet Monitor")}

No wallets monitored yet.

Use ${FormattedString.code("/monitor <address>")} or tap below to start.`;
    const kb = new InlineKeyboard().text("+ Add wallet", "mon:add");
    const opts = { entities: msg.entities, reply_markup: kb };
    if (edit && ctx.callbackQuery) await ctx.editMessageText(msg.text, opts);
    else await ctx.reply(msg.text, opts);
    return;
  }

  const entries: string[] = [];
  const labels: string[] = [];
  for (const [i, r] of rows.entries()) {
    const name = await resolveLabel(r.watchedWallet, r.label);
    labels.push(name);
    entries.push(
      `${i + 1}. 🟢 ${name}\n   ${shortAddr(r.watchedWallet)}\n   Watching: ${watchingSummary(r)}`,
    );
  }

  const msg = fmt`👁 ${FormattedString.b(`Wallet Monitor (${rows.length}/${MAX_MONITORS})`)}

${entries.join("\n\n")}`;

  const kb = new InlineKeyboard();
  for (const [i, r] of rows.entries()) {
    kb.text(`⚙️ ${labels[i]}`, `mon:settings:${r.id}`);
    if (i % 2 === 1 || i === rows.length - 1) kb.row();
  }
  kb.text("+ Add wallet", "mon:add");

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) await ctx.editMessageText(msg.text, opts);
  else await ctx.reply(msg.text, opts);
}

async function sendMonitorSettings(ctx: BotContext, monitorId: string) {
  if (!ctx.user) return;

  const row = await db.query.walletMonitors.findFirst({
    where: and(eq(walletMonitors.id, monitorId), eq(walletMonitors.userId, ctx.user.id)),
  });
  if (!row) {
    await ctx.answerCallbackQuery("Not found.");
    return;
  }

  const name = await resolveLabel(row.watchedWallet, row.label);

  const msg = fmt`👁 ${FormattedString.b(`Monitor — ${name}`)}
${FormattedString.code(shortAddr(row.watchedWallet))}`;

  const posIcon = row.alertOnPositionChange ? "✅" : "❌";
  const fillIcon = row.alertOnFill ? "✅" : "❌";

  const kb = new InlineKeyboard()
    .text(`${posIcon} Position open/close/flip`, `mon:toggle:pos:${monitorId}`)
    .row()
    .text(`${fillIcon} Fill alerts`, `mon:toggle:fill:${monitorId}`)
    .row()
    .text(`✏️ Label: ${name}`, `mon:label:${monitorId}`)
    .row()
    .text("🗑 Remove monitor", `mon:rm:${monitorId}`)
    .row()
    .text("← Back", "mon:list");

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
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

  const msg = fmt`✅ Now monitoring ${FormattedString.code(shortAddr(walletAddress))}

You'll get alerts when this wallet opens, closes, or fills a position.`;
  const kb = new InlineKeyboard().text("← My monitors", "mon:list");
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function handleRemoveMonitor(ctx: BotContext, monitorId: string) {
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
      await ctx.reply("Please run /start first.");
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

  bot.callbackQuery("mon:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendMonitorList(ctx, true);
  });

  // Backwards compat
  bot.callbackQuery("monitor:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendMonitorList(ctx, true);
  });

  bot.callbackQuery("mon:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    await ctx.editMessageText("Send the Solana wallet address you want to monitor:");
    await setPending(ctx.from.id, "monitor_add");
  });

  // Backwards compat
  bot.callbackQuery("monitor:prompt_add", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    await ctx.editMessageText("Send the Solana wallet address you want to monitor:");
    await setPending(ctx.from.id, "monitor_add");
  });

  bot.callbackQuery(/^mon:add:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await handleAddMonitor(ctx, ctx.match[1]);
  });

  // Backwards compat
  bot.callbackQuery(/^monitor:add:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await handleAddMonitor(ctx, ctx.match[1]);
  });

  // ─── Per-monitor settings ──────────────────────────────────────────
  bot.callbackQuery(/^mon:settings:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendMonitorSettings(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^mon:toggle:pos:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const row = await db.query.walletMonitors.findFirst({
      where: and(eq(walletMonitors.id, ctx.match[1]), eq(walletMonitors.userId, ctx.user.id)),
    });
    if (!row) return;
    await db
      .update(walletMonitors)
      .set({ alertOnPositionChange: !row.alertOnPositionChange })
      .where(eq(walletMonitors.id, row.id));
    await sendMonitorSettings(ctx, row.id);
  });

  bot.callbackQuery(/^mon:toggle:fill:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const row = await db.query.walletMonitors.findFirst({
      where: and(eq(walletMonitors.id, ctx.match[1]), eq(walletMonitors.userId, ctx.user.id)),
    });
    if (!row) return;
    await db
      .update(walletMonitors)
      .set({ alertOnFill: !row.alertOnFill })
      .where(eq(walletMonitors.id, row.id));
    await sendMonitorSettings(ctx, row.id);
  });

  bot.callbackQuery(/^mon:label:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    await ctx.editMessageText("Enter a custom label for this wallet (max 32 chars):");
    await setPending(ctx.from.id, `mon_label:${ctx.match[1]}`);
  });

  bot.callbackQuery(/^mon:rm:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const row = await db.query.walletMonitors.findFirst({
      where: and(eq(walletMonitors.id, ctx.match[1]), eq(walletMonitors.userId, ctx.user.id)),
    });
    if (!row) return;

    const name = await resolveLabel(row.watchedWallet, row.label);
    const msg = fmt`🗑 Remove monitor for ${FormattedString.b(name)}?`;
    const kb = new InlineKeyboard()
      .text("🗑 Yes, remove", `mon:rmgo:${row.id}`)
      .text("← Keep it", `mon:settings:${row.id}`);
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^mon:rmgo:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Removed.");
    if (!ctx.user) return;
    await handleRemoveMonitor(ctx, ctx.match[1]);
  });

  // Backwards compat
  bot.callbackQuery(/^monitor:rm:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Removed.");
    if (!ctx.user) return;
    await handleRemoveMonitor(ctx, ctx.match[1]);
  });
}
