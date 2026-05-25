import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { and, eq, isNull } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "../../db/index.js";
import { alertSubscriptions } from "../../db/schema/index.js";
import type { BotContext } from "../../types/index.js";

const ALERT_DEFS = [
  { type: "fill", label: "Order filled", default: true },
  { type: "at_risk", label: "Account at risk", default: true },
  { type: "cancellable", label: "Margin warning", default: true },
  { type: "liquidatable", label: "Near liquidation", default: true },
  { type: "tpsl_flip", label: "TP/SL triggered", default: true },
  { type: "funding_flip", label: "Funding direction change", default: false },
  { type: "large_funding", label: "High funding rate (>50% APR)", default: false },
] as const;

type AlertType = (typeof ALERT_DEFS)[number]["type"];

async function buildAlertsKeyboard(userId: string): Promise<InlineKeyboard> {
  const subs = await db.query.alertSubscriptions.findMany({
    where: eq(alertSubscriptions.userId, userId),
  });

  const kb = new InlineKeyboard();
  for (const def of ALERT_DEFS) {
    const sub = subs.find((s) => s.type === def.type && s.symbol === null);
    const enabled = sub ? sub.enabled : def.default;
    kb.text(`${enabled ? "✅" : "❌"} ${def.label}`, `alert:toggle:${def.type}`).row();
  }
  return kb;
}

const ALERTS_MSG = fmt`🔔 ${FormattedString.b("Alert Settings")}\n\nToggle which notifications you'd like to receive.`;

export async function sendAlertsScreen(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const kb = await buildAlertsKeyboard(ctx.user.id);
  await ctx.reply(ALERTS_MSG.text, { entities: ALERTS_MSG.entities, reply_markup: kb });
}

export function registerAlerts(bot: Bot<BotContext>) {
  bot.command("alerts", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }
    await sendAlertsScreen(ctx);
  });

  bot.callbackQuery(/^alert:toggle:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;

    const type = ctx.match[1] as AlertType;

    const existing = await db.query.alertSubscriptions.findFirst({
      where: and(
        eq(alertSubscriptions.userId, ctx.user.id),
        eq(alertSubscriptions.type, type),
        isNull(alertSubscriptions.symbol),
      ),
    });

    if (existing) {
      await db
        .update(alertSubscriptions)
        .set({ enabled: !existing.enabled })
        .where(eq(alertSubscriptions.id, existing.id));
    } else {
      const def = ALERT_DEFS.find((a) => a.type === type);
      await db.insert(alertSubscriptions).values({
        id: crypto.randomUUID(),
        userId: ctx.user.id,
        type,
        symbol: null,
        enabled: !(def?.default ?? true),
      });
    }

    const kb = await buildAlertsKeyboard(ctx.user.id);
    await ctx.editMessageText(ALERTS_MSG.text, { entities: ALERTS_MSG.entities, reply_markup: kb });
  });
}
