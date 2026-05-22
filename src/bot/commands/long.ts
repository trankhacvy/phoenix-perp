import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { getMarketSnapshot, isIsolatedOnly } from "../../services/phoenix/market.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { placeMarketOrder } from "../../services/phoenix/trade.js";
import { getKitSigner } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { subscribeUser } from "../../workers/ws.js";
import { leveragePickerKeyboard, sizePickerKeyboard } from "../keyboards/trade.js";
import {
  price as fmtPrice,
  fundingApr,
  fundingDir,
  parseAmount,
  parseLeverage,
  solscanUrl,
  usd,
} from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";

export function registerLong(bot: Bot<BotContext>) {
  bot.command("long", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const symbol = parts[0]?.toUpperCase().replace("/USD", "").replace("/USDT", "");

    if (!symbol) {
      await sendSymbolPicker(ctx, "long");
      return;
    }
    if (parts.length >= 3) {
      const lev = parseLeverage(parts[1]);
      const size = parseAmount(parts[2]);
      if (Number.isNaN(lev) || lev < 1 || Number.isNaN(size) || size <= 0) {
        await ctx.reply(
          "Invalid format. Example: /long BTC 10x 500\nOr just type /long BTC to use the guided flow.",
        );
        return;
      }
      await sendTradeConfirm(ctx, "long", symbol, lev, size);
      return;
    }
    await sendLeveragePicker(ctx, "long", symbol);
  });

  bot.callbackQuery(/^trade:long:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    await sendLeveragePicker(ctx, "long", ctx.match[1]);
  });

  bot.callbackQuery(/^trade_lev:long:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendSizePicker(ctx, "long", ctx.match[1], Number(ctx.match[2]));
  });

  bot.callbackQuery(/^trade_lev_custom:long:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const symbol = ctx.match[1];
    const snap = await getMarketSnapshot(symbol).catch(() => null);
    const maxLev = snap?.maxLeverage ?? 100;
    await ctx.reply(`Enter your leverage for ${symbol} (1–${maxLev}x):`);
    await setPending(ctx.from.id, `trade_leverage:long:${symbol}`);
  });

  bot.callbackQuery(/^trade_size:long:([A-Z0-9]+):(\d+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendTradeConfirm(ctx, "long", ctx.match[1], Number(ctx.match[2]), Number(ctx.match[3]));
  });

  bot.callbackQuery(/^trade_size_custom:long:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, levStr] = ctx.match.slice(1);
    const state = await getTraderState(ctx.user.walletAddress);
    const available = Number(state.effectiveCollateral);
    const msg = fmt`Enter the margin amount in USD:\n(Available: ${FormattedString.code(usd(available))})`;
    await ctx.reply(msg.text, { entities: msg.entities });
    await setPending(ctx.from.id, `trade_size:long:${symbol}:${levStr}`);
  });

  bot.callbackQuery(/^confirm:long:([A-Z0-9]+):([\d.]+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Opening trade…");
    if (!ctx.user) return;
    const [symbol, leverageStr, sizeStr, markPriceStr] = ctx.match.slice(1);
    const lev = Number(leverageStr);
    const sizeUsdc = Number(sizeStr);
    const markPrice = Number(markPriceStr);

    try {
      const sig = await placeMarketOrder(
        {
          symbol,
          side: "long",
          baseUnits: String((sizeUsdc * lev) / markPrice),
          walletAddress: ctx.user.walletAddress,
        },
        getKitSigner(ctx.user.walletAddress),
      );
      await subscribeUser(ctx.user.walletAddress, ctx.user.telegramId);

      const kb = new InlineKeyboard()
        .text("📊 View positions", "nav:positions")
        .row()
        .text("🛑 Set stop loss", `editsl:${symbol}:long`)
        .text("🎯 Set take profit", `edittp:${symbol}:long`);

      const totalFee = (sizeUsdc * lev * (3.5 + config.BUILDER_FEE_BPS)) / 10000;
      const msg = fmt`✅ ${FormattedString.b("Trade opened!")}\n\n🟢 ${symbol}/USD — Long ${lev}x\nPosition: ${FormattedString.b(usd(sizeUsdc * lev))}\nFee paid: ${FormattedString.b(usd(totalFee))}\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}`;
      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      logger.error({ err: e, symbol, side: "long" }, "placeMarketOrder failed");
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      const kb = new InlineKeyboard()
        .text("Try again", `trade:long:${symbol}`)
        .text("← Back", "nav:positions");
      const errFmt = fmt`❌ ${FormattedString.b("Trade failed")}\n\n${symbol} Long\nReason: ${FormattedString.code(errMsg)}`;
      await ctx.editMessageText(errFmt.text, { entities: errFmt.entities, reply_markup: kb });
    }
  });
}

export async function sendSymbolPicker(ctx: BotContext, side: "long" | "short"): Promise<void> {
  const popular = ["BTC", "ETH", "SOL", "BNB", "AVAX"];
  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Buy / Long" : "Sell / Short";
  const kb = new InlineKeyboard();
  for (const s of popular) {
    kb.text(s, `trade:${side}:${s}`);
  }
  kb.row().text("Browse all markets →", "markets:page:0");
  const msg = fmt`${emoji} ${FormattedString.b(label)}\n\nChoose a market to open your position:`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendLeveragePicker(
  ctx: BotContext,
  side: "long" | "short",
  symbol: string,
): Promise<void> {
  if (isIsolatedOnly(symbol)) {
    const msg = fmt`⚠️ ${FormattedString.b(symbol)} requires isolated margin — not available yet.\n\nUse /markets to find other markets.`;
    await ctx.reply(msg.text, { entities: msg.entities });
    return;
  }

  let snapshot: Awaited<ReturnType<typeof getMarketSnapshot>>;
  try {
    snapshot = await getMarketSnapshot(symbol);
  } catch {
    await ctx.reply(`Market "${symbol}" not found. Use /markets to browse.`);
    return;
  }

  if (!ctx.user) return;
  const settings = (await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, ctx.user.id),
  })) ?? { slippageBps: 50, defaultLeverage: 5 };

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Buy / Long" : "Sell / Short";

  const fundingNote =
    snapshot.fundingRate !== 0
      ? fmt`Funding  ${FormattedString.b(fundingApr(snapshot.fundingRate))}  ${FormattedString.i(fundingDir(snapshot.fundingRate))}\n`
      : fmt``;

  const kb = leveragePickerKeyboard(side, symbol, snapshot.maxLeverage, settings.defaultLeverage);

  const msg = fmt`${emoji} ${FormattedString.b(`${symbol}/USD — ${label}`)}\n\nPrice    ${FormattedString.b(fmtPrice(snapshot.markPrice))}\n${fundingNote}\nSelect your leverage:\n${FormattedString.i("Higher leverage amplifies both gains and losses.")}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendSizePicker(
  ctx: BotContext,
  side: "long" | "short",
  symbol: string,
  lev: number,
): Promise<void> {
  if (!ctx.user) return;
  const [snapshot, state] = await Promise.all([
    getMarketSnapshot(symbol),
    getTraderState(ctx.user.walletAddress),
  ]);

  const available = Number(state.effectiveCollateral);

  if (available <= 0) {
    const kb = new InlineKeyboard().text("📥 Deposit", "nav:deposit");
    const msg = fmt`No funds available to trade. You have ${FormattedString.b(usd(available))}.\n\nDeposit funds first.`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
    return;
  }

  const effectiveLev = Math.min(lev, snapshot.maxLeverage);
  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";

  const warning =
    lev > snapshot.maxLeverage
      ? fmt`\n⚠️ Leverage capped to ${FormattedString.b(`${snapshot.maxLeverage}x`)} (market max for ${symbol}).\n`
      : fmt``;

  const kb = sizePickerKeyboard(side, symbol, effectiveLev, available);

  const msg = fmt`${emoji} ${FormattedString.b(`${symbol}/USD — ${label} ${effectiveLev}x`)}${warning}\n\nAvailable margin  ${FormattedString.b(usd(available))}\n\nHow much margin do you want to use?\n${FormattedString.i("Each button shows % of your available margin.")}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendTradeConfirm(
  ctx: BotContext,
  side: "long" | "short",
  symbol: string,
  lev: number,
  sizeUsdc: number,
): Promise<void> {
  if (!ctx.user) return;
  const [snapshot, state] = await Promise.all([
    getMarketSnapshot(symbol).catch(() => null),
    getTraderState(ctx.user.walletAddress),
  ]);

  if (!snapshot) {
    await ctx.reply(`Market "${symbol}" not found.`);
    return;
  }

  const available = Number(state.effectiveCollateral);
  if (sizeUsdc > available) {
    const msg = fmt`You only have ${FormattedString.b(usd(available))} available. Enter a smaller amount.`;
    await ctx.reply(msg.text, { entities: msg.entities });
    return;
  }
  const effectiveLev = Math.min(lev, snapshot.maxLeverage);
  const notional = sizeUsdc * effectiveLev;
  const entry = snapshot.markPrice;
  const liqPrice =
    side === "long" ? entry * (1 - 1 / effectiveLev) : entry * (1 + 1 / effectiveLev);
  const liqPct = (100 / effectiveLev).toFixed(0);

  const totalFee = (notional * (3.5 + config.BUILDER_FEE_BPS)) / 10000;
  const totalCost = sizeUsdc + totalFee;

  const absApr = Math.abs(snapshot.fundingRate * 1095 * 100);
  const fundingPerDay = (notional * Math.abs(snapshot.fundingRate) * 3).toFixed(2);
  const fundingNote =
    absApr > 10
      ? fmt`\n⚠️ Funding: ${FormattedString.code(fundingApr(snapshot.fundingRate))} — you pay ≈${FormattedString.code(`$${fundingPerDay}`)}/day on this position.`
      : fmt``;

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";
  const dirWord = side === "long" ? "drops to" : "rises to";

  const kb = new InlineKeyboard()
    .text(
      "✅ Open trade",
      `confirm:${side}:${symbol}:${effectiveLev}:${sizeUsdc}:${entry.toFixed(4)}`,
    )
    .text("✕ Cancel", "cancel");

  const msg = fmt`📋 ${FormattedString.b("Confirm your trade")}\n\n${emoji} ${symbol}/USD — ${label} ${effectiveLev}x\n\nPosition value  ${FormattedString.b(usd(notional))}\nYour margin     ${FormattedString.b(usd(sizeUsdc))}\nEntry price     ${FormattedString.b(`~${fmtPrice(entry)}`)}\nFee             ${FormattedString.b(usd(totalFee))}\nTotal cost      ${FormattedString.b(usd(totalCost))}\n\nLiquidated if price ${dirWord} ${FormattedString.b(fmtPrice(liqPrice))}  ${FormattedString.i(`(-${liqPct}%)`)}${fundingNote}`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
