import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { and, eq, isNull } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "../../db/index.js";
import { alertSubscriptions } from "../../db/schema/index.js";
import type { BotContext } from "../../types/index.js";

const ALERT_DEFS = [
  { type: "at_risk", label: "Account at risk", default: true },
  { type: "cancellable", label: "Margin warning", default: true },
  { type: "liquidatable", label: "Near liquidation", default: true },
  { type: "tpsl_flip", label: "TP/SL triggered", default: true },
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
  kb.text("← Back to Settings", "settings:back");
  return kb;
}

const ALERTS_MSG = fmt`🔔 ${FormattedString.b("Notifications")}

Toggle which alerts you receive. These fire in real-time via WebSocket.

${FormattedString.i("Price alerts are managed separately via /pricealert.")}
${FormattedString.i("Wallet monitors via /monitor.")}`;

export async function sendAlertsScreen(ctx: BotContext, edit = false): Promise<void> {
  if (!ctx.user) return;
  const kb = await buildAlertsKeyboard(ctx.user.id);
  const opts = { entities: ALERTS_MSG.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(ALERTS_MSG.text, opts);
  } else {
    await ctx.reply(ALERTS_MSG.text, opts);
  }
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

    await sendAlertsScreen(ctx, true);
  });
}
