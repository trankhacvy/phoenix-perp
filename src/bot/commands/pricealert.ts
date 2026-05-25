import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "../../db/index.js";
import { alertSubscriptions } from "../../db/schema/index.js";
import { getMarketSnapshot } from "../../services/phoenix/market.js";
import type { BotContext } from "../../types/index.js";
import { price as fmtPrice, parseAmount } from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";

export async function sendPriceAlertPrompt(ctx: BotContext, symbol: string): Promise<void> {
  let markPrice: number | null = null;
  try {
    const snap = await getMarketSnapshot(symbol);
    markPrice = snap.markPrice;
  } catch {
    // market not found — still allow setting alert
  }

  const priceNote =
    markPrice !== null ? fmt`\nCurrent price: ${FormattedString.code(fmtPrice(markPrice))}` : fmt``;

  const msg = fmt`🔔 ${FormattedString.b(`Price Alert — ${symbol}`)}${priceNote}\n\nEnter the price you want to be alerted at.\n\nExample: ${FormattedString.code("150")}  (alert when price reaches $150)`;

  await ctx.reply(msg.text, { entities: msg.entities });
  if (!ctx.from) return;
  await setPending(ctx.from.id, `pricealert:${symbol}`);
}

export async function sendPriceAlertConfirm(
  ctx: BotContext,
  symbol: string,
  triggerPrice: number,
): Promise<void> {
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

  const kb = new InlineKeyboard()
    .text("✅ Set alert", `pricealert:exec:${symbol}:${triggerPrice}:${direction}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`Set price alert?\n\n${FormattedString.b(symbol)} — notify when ${dirLabel} ${FormattedString.code(fmtPrice(triggerPrice))}`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export function registerPriceAlert(bot: Bot<BotContext>) {
  bot.command("alert", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }

    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const symbol = parts[0]?.toUpperCase();

    if (!symbol) {
      await ctx.reply("Usage: /alert SOL 150\n\nEnter a symbol and target price.");
      return;
    }

    if (parts.length < 2) {
      await sendPriceAlertPrompt(ctx, symbol);
      return;
    }

    const triggerPrice = parseAmount(parts[1]);
    if (Number.isNaN(triggerPrice) || triggerPrice <= 0) {
      await ctx.reply("Invalid price. Enter a positive number.");
      return;
    }

    await sendPriceAlertConfirm(ctx, symbol, triggerPrice);
  });

  bot.callbackQuery(/^pricealert:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendPriceAlertPrompt(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^pricealert:exec:([A-Z0-9]+):([\d.]+):(above|below)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Setting alert…");
    if (!ctx.user) return;
    const [symbol, priceStr, direction] = ctx.match.slice(1) as [string, string, "above" | "below"];
    const triggerPrice = Number(priceStr);
    const storedPrice = direction === "below" ? -triggerPrice : triggerPrice;

    await db.insert(alertSubscriptions).values({
      id: crypto.randomUUID(),
      userId: ctx.user.id,
      type: "price",
      symbol,
      triggerPrice: String(storedPrice),
      enabled: true,
    });

    const dirLabel = direction === "above" ? "rises above" : "drops below";
    const msg = fmt`🔔 Alert set: ${FormattedString.b(symbol)} — notify when price ${dirLabel} ${FormattedString.code(fmtPrice(triggerPrice))}`;
    await ctx.editMessageText(msg.text, { entities: msg.entities });
  });
}
