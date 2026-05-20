import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { alertSubscriptions } from "../../db/schema/index.js";
import type { BotContext } from "../../types/index.js";

const DEFAULT_ALERTS = [
  { type: "at_risk", label: "AtRisk warning", default: true },
  { type: "cancellable", label: "Cancellable warning", default: true },
  { type: "liquidatable", label: "Liquidation warning", default: true },
  { type: "fill", label: "Fill notification", default: true },
  { type: "tpsl_flip", label: "TP/SL flip", default: true },
  { type: "funding_flip", label: "Funding flip", default: false },
  { type: "large_funding", label: "Large funding (>50% APR)", default: false },
] as const;

async function buildAlertsKeyboard(userId: string) {
  const subs = await db.query.alertSubscriptions.findMany({
    where: eq(alertSubscriptions.userId, userId),
  });

  const kb = new InlineKeyboard();
  for (const a of DEFAULT_ALERTS) {
    const sub = subs.find((s) => s.type === a.type);
    const enabled = sub ? sub.enabled : a.default;
    kb.text(`${enabled ? "✅" : "❌"} ${a.label}`, `alert:toggle:${a.type}`).row();
  }
  return kb;
}

export function registerAlerts(bot: Bot<BotContext>) {
  bot.command("alerts", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const kb = await buildAlertsKeyboard(ctx.user.id);
    await ctx.reply("<b>Alert Settings</b>", { parse_mode: "HTML", reply_markup: kb });
  });

  bot.callbackQuery(/^alert:toggle:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;

    const type = ctx.match[1] as (typeof DEFAULT_ALERTS)[number]["type"];

    const existing = await db.query.alertSubscriptions.findFirst({
      where: and(
        eq(alertSubscriptions.userId, ctx.user.id),
        eq(alertSubscriptions.type, type),
      ),
    });

    if (existing) {
      await db
        .update(alertSubscriptions)
        .set({ enabled: !existing.enabled })
        .where(eq(alertSubscriptions.id, existing.id));
    } else {
      const def = DEFAULT_ALERTS.find((a) => a.type === type);
      await db.insert(alertSubscriptions).values({
        id: crypto.randomUUID(),
        userId: ctx.user.id,
        type,
        enabled: !(def?.default ?? true),
      });
    }

    const kb = await buildAlertsKeyboard(ctx.user.id);
    await ctx.editMessageText("<b>Alert Settings</b>", { parse_mode: "HTML", reply_markup: kb });
  });
}
