import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { and, eq, isNull } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "../../db/index.js";
import { alertSubscriptions } from "../../db/schema/index.js";
import { getMarketSnapshot, getMarkets } from "../../services/phoenix/market.js";
import type { BotContext } from "../../types/index.js";
import { bustPriceAlertCache } from "../../workers/evaluators/index.js";
import { price as fmtPrice, parseAmount } from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";

const ACCOUNT_ALERT_DEFS = [
  {
    type: "at_risk" as const,
    label: "Margin warning",
    desc: "collateral drops below initial margin",
    default: true,
    alsoToggle: "cancellable" as const,
  },
  {
    type: "liquidatable" as const,
    label: "Near liquidation",
    desc: "account can be liquidated",
    default: true,
  },
  {
    type: "tpsl_flip" as const,
    label: "TP/SL triggered",
    desc: "position flipped direction",
    default: true,
  },
];

type AlertType = (typeof alertSubscriptions.type.enumValues)[number];

async function getAlertEnabled(userId: string, alertType: AlertType): Promise<boolean> {
  const row = await db.query.alertSubscriptions.findFirst({
    where: and(
      eq(alertSubscriptions.userId, userId),
      eq(alertSubscriptions.type, alertType),
      isNull(alertSubscriptions.symbol),
    ),
  });
  const def = ACCOUNT_ALERT_DEFS.find((d) => d.type === alertType);
  return row ? row.enabled : (def?.default ?? true);
}

async function toggleAccountAlert(userId: string, alertType: AlertType) {
  const existing = await db.query.alertSubscriptions.findFirst({
    where: and(
      eq(alertSubscriptions.userId, userId),
      eq(alertSubscriptions.type, alertType),
      isNull(alertSubscriptions.symbol),
    ),
  });

  if (existing) {
    await db
      .update(alertSubscriptions)
      .set({ enabled: !existing.enabled })
      .where(eq(alertSubscriptions.id, existing.id));
  } else {
    const def = ACCOUNT_ALERT_DEFS.find((a) => a.type === alertType);
    await db.insert(alertSubscriptions).values({
      id: crypto.randomUUID(),
      userId,
      type: alertType,
      symbol: null,
      enabled: !(def?.default ?? true),
    });
  }
}

async function getActivePriceAlertCount(userId: string): Promise<number> {
  const rows = await db.query.alertSubscriptions.findMany({
    where: and(
      eq(alertSubscriptions.userId, userId),
      eq(alertSubscriptions.type, "price"),
      eq(alertSubscriptions.enabled, true),
    ),
  });
  return rows.length;
}

export async function sendAlertsHub(ctx: BotContext, edit = false) {
  if (!ctx.user) return;
  const userId = ctx.user.id;

  const priceCount = await getActivePriceAlertCount(userId);
  const states = await Promise.all(
    ACCOUNT_ALERT_DEFS.map(async (d) => ({
      ...d,
      enabled: await getAlertEnabled(userId, d.type),
    })),
  );

  const accountLines = states.map((s) => `  ${s.enabled ? "✅" : "❌"} ${s.label}`);

  const msg = fmt`🔔 ${FormattedString.b("Alerts")}

📊 ${FormattedString.b("Account Alerts")}
${accountLines.join("\n")}

💰 ${FormattedString.b(`Price Alerts (${priceCount} active)`)}`;

  const kb = new InlineKeyboard()
    .text("⚙️ Account alerts", "al:acct")
    .row()
    .text("💰 Price alerts", "al:prices")
    .row()
    .text("+ New price alert", "al:pa:add")
    .row()
    .text("🛡 Risk Guardian", "grd:list")
    .text("✕ Close", "al:close");

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) await ctx.editMessageText(msg.text, opts);
  else await ctx.reply(msg.text, opts);
}

async function sendAccountAlerts(ctx: BotContext) {
  if (!ctx.user) return;
  const userId = ctx.user.id;

  const states = await Promise.all(
    ACCOUNT_ALERT_DEFS.map(async (d) => ({
      ...d,
      enabled: await getAlertEnabled(userId, d.type),
    })),
  );

  const msg = fmt`🔔 ${FormattedString.b("Account Alerts")}

Toggle which alerts you receive in real-time.

${states.map((s) => `${s.enabled ? "✅" : "❌"} ${s.label} — ${s.desc}`).join("\n")}`;

  const kb = new InlineKeyboard();
  for (const s of states) {
    kb.text(`${s.enabled ? "✅" : "❌"} ${s.label}`, `al:toggle:${s.type}`).row();
  }
  kb.text("← Back", "al:main");

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendPriceAlertList(ctx: BotContext) {
  if (!ctx.user) return;

  const alerts = await db.query.alertSubscriptions.findMany({
    where: and(
      eq(alertSubscriptions.userId, ctx.user.id),
      eq(alertSubscriptions.type, "price"),
      eq(alertSubscriptions.enabled, true),
    ),
  });

  if (alerts.length === 0) {
    const msg = fmt`💰 ${FormattedString.b("Price Alerts")}

No price alerts set.

Use price alerts to get notified when a market reaches a specific price level.`;

    const kb = new InlineKeyboard()
      .text("+ Add price alert", "al:pa:add")
      .row()
      .text("← Back", "al:main");
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
    return;
  }

  const lines = alerts.map((a, i) => {
    const trigger = Number(a.triggerPrice ?? 0);
    const dir = trigger >= 0 ? "🔼 above" : "🔽 below";
    const price = fmtPrice(Math.abs(trigger));
    return `${i + 1}. ${a.symbol} — ${dir} ${price}`;
  });

  const msg = fmt`💰 ${FormattedString.b(`Price Alerts (${alerts.length}/20)`)}

${lines.join("\n")}`;

  const kb = new InlineKeyboard();
  for (const a of alerts) {
    const trigger = Number(a.triggerPrice ?? 0);
    const label = `🗑 ${a.symbol} $${Math.abs(trigger).toFixed(0)}`;
    kb.text(label, `al:pa:rm:${a.id}`);
  }
  kb.row().text("+ Add new", "al:pa:add").row();
  if (alerts.length > 1) kb.text("🗑 Clear all", "al:pa:rmall").row();
  kb.text("← Back", "al:main");

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendSymbolPicker(ctx: BotContext) {
  const markets = await getMarkets();
  const top = markets.slice(0, 10);
  const kb = new InlineKeyboard();
  for (let i = 0; i < top.length; i += 2) {
    kb.text(top[i].symbol, `al:pa:add:${top[i].symbol}`);
    if (top[i + 1]) kb.text(top[i + 1].symbol, `al:pa:add:${top[i + 1].symbol}`);
    kb.row();
  }
  kb.text("← Back", "al:main");

  const msg = fmt`💰 ${FormattedString.b("New Price Alert")} — choose a market:`;
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendPricePrompt(ctx: BotContext, symbol: string) {
  if (!ctx.from) return;
  let priceNote = "";
  try {
    const snap = await getMarketSnapshot(symbol);
    priceNote = `\nCurrent price: ${fmtPrice(snap.markPrice)}`;
  } catch {
    // ok
  }
  await ctx.editMessageText(
    `💰 Price Alert — ${symbol}${priceNote}\n\nEnter the price you want to be alerted at.\nExample: 150`,
  );
  await setPending(ctx.from.id, `al_pricealert:${symbol}`);
}

export async function sendPriceAlertConfirm(ctx: BotContext, symbol: string, triggerPrice: number) {
  let markPrice: number | null = null;
  try {
    const snap = await getMarketSnapshot(symbol);
    markPrice = snap.markPrice;
  } catch {
    // ignore
  }

  const direction: "above" | "below" =
    markPrice !== null ? (triggerPrice >= markPrice ? "above" : "below") : "above";
  const dirLabel = direction === "above" ? "🔼 rises above" : "🔽 drops below";

  const distPart =
    markPrice !== null
      ? `\n(Current: ${fmtPrice(markPrice)} · $${Math.abs(triggerPrice - markPrice).toFixed(2)} away)`
      : "";

  const msg = fmt`💰 Set price alert?

${FormattedString.b(symbol)} — notify when price ${dirLabel} ${FormattedString.code(fmtPrice(triggerPrice))}${distPart}`;

  const kb = new InlineKeyboard()
    .text("✅ Set alert", `al:pa:exec:${symbol}:${triggerPrice}:${direction}`)
    .text("✕ Cancel", "al:main");

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

const MAX_PRICE_ALERTS = 20;

export function registerAlerts(bot: Bot<BotContext>) {
  bot.command("alerts", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first.");
      return;
    }
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    if (parts.length >= 2) {
      const symbol = parts[0].toUpperCase();
      const triggerPrice = parseAmount(parts[1]);
      if (!Number.isNaN(triggerPrice) && triggerPrice > 0) {
        await sendPriceAlertConfirm(ctx, symbol, triggerPrice);
        return;
      }
    }
    await sendAlertsHub(ctx);
  });

  bot.command("alert", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first.");
      return;
    }
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const symbol = parts[0]?.toUpperCase();
    if (!symbol) {
      await sendAlertsHub(ctx);
      return;
    }
    if (parts.length >= 2) {
      const triggerPrice = parseAmount(parts[1]);
      if (!Number.isNaN(triggerPrice) && triggerPrice > 0) {
        await sendPriceAlertConfirm(ctx, symbol, triggerPrice);
        return;
      }
    }
    if (!ctx.from) return;
    let priceNote = "";
    try {
      const snap = await getMarketSnapshot(symbol);
      priceNote = `\nCurrent price: ${fmtPrice(snap.markPrice)}`;
    } catch {
      // ok
    }
    await ctx.reply(
      `💰 Price Alert — ${symbol}${priceNote}\n\nEnter the price you want to be alerted at.`,
    );
    await setPending(ctx.from.id, `al_pricealert:${symbol}`);
  });

  // ─── Hub navigation ────────────────────────────────────────────────
  bot.callbackQuery("al:main", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendAlertsHub(ctx, true);
  });

  bot.callbackQuery("al:close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => undefined);
  });

  // ─── Account alerts ────────────────────────────────────────────────
  bot.callbackQuery("al:acct", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendAccountAlerts(ctx);
  });

  bot.callbackQuery(/^al:toggle:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const alertType = ctx.match[1] as AlertType;
    await toggleAccountAlert(ctx.user.id, alertType);
    const def = ACCOUNT_ALERT_DEFS.find((d) => d.type === alertType);
    if (def && "alsoToggle" in def && def.alsoToggle) {
      await toggleAccountAlert(ctx.user.id, def.alsoToggle);
    }
    await sendAccountAlerts(ctx);
  });

  // Backwards compat: old callback namespace
  bot.callbackQuery(/^alert:toggle:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const alertType = ctx.match[1] as AlertType;
    await toggleAccountAlert(ctx.user.id, alertType);
    const def = ACCOUNT_ALERT_DEFS.find((d) => d.type === alertType);
    if (def && "alsoToggle" in def && def.alsoToggle) {
      await toggleAccountAlert(ctx.user.id, def.alsoToggle);
    }
    await sendAccountAlerts(ctx);
  });

  // ─── Price alerts ──────────────────────────────────────────────────
  bot.callbackQuery("al:prices", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendPriceAlertList(ctx);
  });

  bot.callbackQuery("al:pa:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendSymbolPicker(ctx);
  });

  bot.callbackQuery(/^al:pa:add:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendPricePrompt(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^al:pa:exec:([A-Z0-9]+):([\d.]+):(above|below)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Setting alert…");
    if (!ctx.user) return;
    const [symbol, priceStr, direction] = ctx.match.slice(1) as [string, string, "above" | "below"];
    const triggerPrice = Number(priceStr);
    const storedPrice = direction === "below" ? -triggerPrice : triggerPrice;

    const existing = await db.query.alertSubscriptions.findMany({
      where: and(
        eq(alertSubscriptions.userId, ctx.user.id),
        eq(alertSubscriptions.type, "price"),
        eq(alertSubscriptions.enabled, true),
      ),
    });
    if (existing.length >= MAX_PRICE_ALERTS) {
      await ctx.editMessageText(
        `You already have ${MAX_PRICE_ALERTS} active price alerts. Remove some first.`,
      );
      return;
    }

    await db.insert(alertSubscriptions).values({
      id: crypto.randomUUID(),
      userId: ctx.user.id,
      type: "price",
      symbol,
      triggerPrice: String(storedPrice),
      enabled: true,
    });
    bustPriceAlertCache();

    const msg = fmt`✅ ${FormattedString.b("Price alert set")}

${FormattedString.b(symbol)} — ${direction === "above" ? "🔼 above" : "🔽 below"} ${FormattedString.code(fmtPrice(triggerPrice))}

Alert fires once, then auto-disables.`;

    const kb = new InlineKeyboard().text("💰 My alerts", "al:prices").text("✕ Close", "al:close");
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  // Backwards compat: old pricealert callbacks
  bot.callbackQuery(/^pricealert:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendPricePrompt(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^pricealert:exec:([A-Z0-9]+):([\d.]+):(above|below)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Setting alert…");
    if (!ctx.user) return;
    const [symbol, priceStr, direction] = ctx.match.slice(1) as [string, string, "above" | "below"];
    const triggerPrice = Number(priceStr);
    const storedPrice = direction === "below" ? -triggerPrice : triggerPrice;

    const existing = await db.query.alertSubscriptions.findMany({
      where: and(
        eq(alertSubscriptions.userId, ctx.user.id),
        eq(alertSubscriptions.type, "price"),
        eq(alertSubscriptions.enabled, true),
      ),
    });
    if (existing.length >= MAX_PRICE_ALERTS) {
      await ctx.editMessageText(`Max ${MAX_PRICE_ALERTS} price alerts.`);
      return;
    }

    await db.insert(alertSubscriptions).values({
      id: crypto.randomUUID(),
      userId: ctx.user.id,
      type: "price",
      symbol,
      triggerPrice: String(storedPrice),
      enabled: true,
    });
    bustPriceAlertCache();

    const msg = fmt`✅ Alert set: ${FormattedString.b(symbol)} — ${direction === "above" ? "above" : "below"} ${FormattedString.code(fmtPrice(triggerPrice))}`;
    await ctx.editMessageText(msg.text, { entities: msg.entities });
  });

  // ─── Price alert deletion ─────────────────────────────────────────
  bot.callbackQuery(/^al:pa:rm:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Removed.");
    if (!ctx.user) return;
    await db
      .delete(alertSubscriptions)
      .where(
        and(eq(alertSubscriptions.id, ctx.match[1]), eq(alertSubscriptions.userId, ctx.user.id)),
      );
    bustPriceAlertCache();
    await sendPriceAlertList(ctx);
  });

  bot.callbackQuery("al:pa:rmall", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const count = await getActivePriceAlertCount(ctx.user.id);
    const msg = fmt`🗑 Delete all ${String(count)} price alerts?`;
    const kb = new InlineKeyboard()
      .text("🗑 Clear all", "al:pa:rmallgo")
      .text("✕ Cancel", "al:prices");
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery("al:pa:rmallgo", async (ctx) => {
    await ctx.answerCallbackQuery("Cleared.");
    if (!ctx.user) return;
    await db
      .delete(alertSubscriptions)
      .where(and(eq(alertSubscriptions.userId, ctx.user.id), eq(alertSubscriptions.type, "price")));
    bustPriceAlertCache();
    await sendPriceAlertList(ctx);
  });

  bot.callbackQuery(/^al:pa:reenable:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Re-enabled.");
    if (!ctx.user) return;
    await db
      .update(alertSubscriptions)
      .set({ enabled: true })
      .where(
        and(eq(alertSubscriptions.id, ctx.match[1]), eq(alertSubscriptions.userId, ctx.user.id)),
      );
    bustPriceAlertCache();
  });
}

export { sendAlertsHub as sendAlertsScreen };
