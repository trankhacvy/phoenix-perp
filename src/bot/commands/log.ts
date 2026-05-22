import { desc, eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { db } from "../../db/index.js";
import { actionLogs } from "../../db/schema/index.js";
import type { BotContext } from "../../types/index.js";

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function registerLog(bot: Bot<BotContext>) {
  bot.command("log", async (ctx) => {
    if (!ctx.from || !ADMIN_IDS.includes(String(ctx.from.id))) {
      return;
    }
    const target = ctx.match?.trim() || String(ctx.from.id);
    const rows = await db
      .select()
      .from(actionLogs)
      .where(eq(actionLogs.userId, target))
      .orderBy(desc(actionLogs.createdAt))
      .limit(10);

    if (rows.length === 0) {
      await ctx.reply(`No log entries for ${target}.`);
      return;
    }

    const lines = rows.map((r) => {
      const ts = r.createdAt.toISOString();
      const err = r.errorCode ? ` (${r.errorCode})` : "";
      return `${ts} · ${r.command} · ${r.outcome}${err} · ${r.durationMs}ms`;
    });
    await ctx.reply(`Last ${rows.length} for ${target}:\n${lines.join("\n")}`);
  });
}
