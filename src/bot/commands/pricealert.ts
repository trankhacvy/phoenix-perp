import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import { db } from "../../db/index.js";
import { alertSubscriptions } from "../../db/schema/index.js";
import { getMarketSnapshot } from "../../services/phoenix/market.js";
import { setPending } from "../lib/pending.js";
import { price as fmtPrice, parseAmount } from "../lib/fmt.js";
import type { BotContext } from "../../types/index.js";

export async function sendPriceAlertPrompt(ctx: BotContext, symbol: string): Promise<void> {
  let markPrice: number | null = null;
  try {
    const snap = await getMarketSnapshot(symbol);
    markPrice = snap.markPrice;
  } catch {
    // market not found — still allow setting alert
  }

  const priceNote =
    markPrice !== null
      ? fmt`\nCurrent price: ${FormattedString.code(fmtPrice(markPrice))}`
      : fmt``;

  const msg = fmt`🔔 ${FormattedString.b(`Price Alert — ${symbol}`)}${priceNote}\n\nEnter the price you want to be alerted at.\n\nExample: ${FormattedString.code("150")}  (alert when price reaches $150)`;

  await ctx.reply(msg.text, { entities: msg.entities });
  await setPending(ctx.from!.id, `pricealert:${symbol}`);
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

  const direction =
    markPrice !== null
      ? triggerPrice >= markPrice
        ? "rises to or above"
        : "drops to or below"
      : "reaches";

  const kb = new InlineKeyboard()
    .text("✅ Set alert", `pricealert:exec:${symbol}:${triggerPrice}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`Set price alert?\n\n${FormattedString.b(symbol)} — alert when price ${direction} ${FormattedString.code(fmtPrice(triggerPrice))}`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export function registerPriceAlert(bot: Bot<BotContext>) {
  bot.command("alert", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
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
    if (isNaN(triggerPrice) || triggerPrice <= 0) {
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

  bot.callbackQuery(/^pricealert:exec:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Setting alert…");
    if (!ctx.user) return;
    const [symbol, priceStr] = ctx.match.slice(1) as [string, string];
    const triggerPrice = Number(priceStr);

    await db.insert(alertSubscriptions).values({
      id: crypto.randomUUID(),
      userId: ctx.user.id,
      type: "price",
      symbol,
      triggerPrice: String(triggerPrice),
      enabled: true,
    });

    const msg = fmt`🔔 Alert set: ${FormattedString.b(symbol)} at ${FormattedString.code(fmtPrice(triggerPrice))}`;
    await ctx.editMessageText(msg.text, { entities: msg.entities });
  });
}
