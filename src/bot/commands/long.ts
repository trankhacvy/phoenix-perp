import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { trackAction } from "../../services/action-log.js";
import { marginToTokens } from "../../services/phoenix/lots.js";
import { getMarketSnapshot, getMarkets, isIsolatedOnly } from "../../services/phoenix/market.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { type PreflightResult, preflightOpen } from "../../services/phoenix/preflight.js";
import { placeMarketOrder } from "../../services/phoenix/trade.js";
import type { BotContext } from "../../types/index.js";
import { subscribeUser } from "../../workers/ws.js";
import { leveragePickerKeyboard, sizePickerKeyboard } from "../keyboards/trade.js";
import { renderBotError, toBotError } from "../lib/errors.js";
import {
  price as fmtPrice,
  fundingDailyUsd,
  liqDistanceLabel,
  parseAmount,
  parseLeverage,
  solscanUrl,
  usd,
} from "../lib/fmt.js";
import { addPaginationRow, paginate } from "../lib/paginate.js";
import { setPending } from "../lib/pending.js";
import { checkOrderRateLimit } from "../middleware/rate-limit.js";

export function registerLong(bot: Bot<BotContext>) {
  bot.command("long", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    if (!ctx.user.phoenixActivated) {
      const kb = new InlineKeyboard().text("Activate account", "nav:activate");
      await ctx.reply(
        "Your trading account isn't activated yet.\nUse /activate <code> to unlock trading.",
        { reply_markup: kb },
      );
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
      if (Number.isNaN(lev) || lev < 1 || !Number.isFinite(lev)) {
        await ctx.reply(
          "Invalid leverage — use a number like 10 or 2.5x (minimum 1).\nExample: /long BTC 10x 500",
        );
        return;
      }
      if (Number.isNaN(size) || size <= 0) {
        await ctx.reply("Invalid amount.\nExample: /long BTC 10x 500");
        return;
      }
      await sendTradeConfirm(ctx, "long", symbol, lev, size);
      return;
    }

    await sendSizeStep(ctx, "long", symbol);
  });

  bot.callbackQuery(/^trade_sym:long:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendSymbolPickerPage(ctx, "long", Number(ctx.match[1]), true);
  });

  bot.callbackQuery(/^trade:long:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!ctx.user.phoenixActivated) {
      await ctx.reply("Activate your account first. Use /activate <code>.");
      return;
    }
    await sendSizeStep(ctx, "long", ctx.match[1]);
  });

  bot.callbackQuery(/^trade_size:long:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendLevStep(ctx, "long", ctx.match[1], Number(ctx.match[2]));
  });

  bot.callbackQuery(/^trade_size_custom:long:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const symbol = ctx.match[1];
    const state = await getTraderState(ctx.user.walletAddress);
    const available = Number(state.effectiveCollateral);
    const msg = fmt`Enter the amount you want to risk (USD):\n(Your balance: ${FormattedString.code(usd(available))})`;
    await ctx.reply(msg.text, { entities: msg.entities });
    await setPending(ctx.from.id, `trade_size_input:long:${symbol}`);
  });

  bot.callbackQuery(/^trade_lev:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, amtStr, levStr] = ctx.match.slice(1);
    await sendTradeConfirm(ctx, "long", symbol, Number(levStr), Number(amtStr));
  });

  bot.callbackQuery(/^trade_lev_custom:long:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, amtStr] = ctx.match.slice(1);
    const snap = await getMarketSnapshot(symbol).catch(() => null);
    const maxLev = snap?.maxLeverage ?? 100;
    await ctx.reply(`Enter your leverage for ${symbol} (1–${maxLev}×):`);
    await setPending(ctx.from.id, `trade_lev_input:long:${symbol}:${amtStr}`);
  });

  bot.callbackQuery(/^trade_refresh:long:([A-Z0-9]+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Refreshing…");
    if (!ctx.user) return;
    const [symbol, levStr, amtStr] = ctx.match.slice(1);
    await sendTradeConfirm(ctx, "long", symbol, Number(levStr), Number(amtStr), true);
  });

  bot.callbackQuery(/^confirm:long:([A-Z0-9]+):([\d.]+):([\d.]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Opening…");
    if (!ctx.user) return;
    if (!(await checkOrderRateLimit(ctx))) return;

    const [symbol, leverageStr, sizeStr, anchorStr] = ctx.match.slice(1);
    const lev = Number(leverageStr);
    const sizeUsdc = Number(sizeStr);
    const anchorPrice = Number(anchorStr);

    let pf: PreflightResult;
    try {
      pf = await preflightOpen({
        user: ctx.user,
        symbol,
        side: "long",
        marginUsdc: sizeUsdc,
        leverage: lev,
        anchorPrice,
      });
    } catch (e) {
      const be = toBotError(e);
      ctx.actionLog = { outcome: "error", errorCode: be.code, errorCategory: be.category };
      if (be.code === "PRICE_DRIFT") {
        const kb = new InlineKeyboard()
          .text("🔄 Refresh price", `trade_refresh:long:${symbol}:${lev}:${sizeUsdc}`)
          .row()
          .text("✕ Cancel", "cancel");
        await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
        return;
      }
      const kb = new InlineKeyboard()
        .text("← Resize", `trade:long:${symbol}`)
        .text("✕ Cancel", "cancel");
      await renderBotError(ctx, be, { action: "Trade", edit: true, replyMarkup: kb });
      return;
    }

    try {
      const baseUnits = marginToTokens(
        pf.snapshot,
        sizeUsdc,
        pf.effectiveLeverage,
        anchorPrice > 0 ? anchorPrice : undefined,
      );
      const { walletAddress: wallet, telegramId } = ctx.user;
      const sig = await trackAction(
        {
          userId: ctx.user.id,
          command: "trade.long",
          args: {
            symbol,
            leverage: pf.effectiveLeverage,
            marginUsdc: sizeUsdc,
            notional: pf.notional,
          },
        },
        () =>
          placeMarketOrder({
            symbol,
            side: "long",
            baseUnits,
            walletAddress: wallet,
          }),
      );
      ctx.actionLog = { skip: true };
      await subscribeUser(wallet, telegramId);

      const liqHint = liqDistanceLabel("long", pf.snapshot.markPrice, pf.liqPrice);
      const kb = new InlineKeyboard()
        .text("🛑 Set stop loss", `editsl:${symbol}:long`)
        .row()
        .text("📊 View position", "nav:positions");

      const msg = fmt`✅ ${FormattedString.b(`Opened — Long ${usd(pf.notional, 0, 0)} of ${symbol}`)}\n\nEntry: ~${fmtPrice(pf.snapshot.markPrice)}\nFee paid: ${usd(pf.feeUsdc)}\n\n⚠️ No stop loss set. If price ${liqHint} you get stopped out.\n\n${FormattedString.link("Solscan ↗", solscanUrl(sig))}`;
      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      logger.error({ err: e, symbol, side: "long" }, "placeMarketOrder failed");
      ctx.actionLog = { skip: true };
      const kb = new InlineKeyboard()
        .text("Try again", `trade:long:${symbol}`)
        .text("← Back", "nav:positions");
      await renderBotError(ctx, e, { action: "Trade", edit: true, replyMarkup: kb });
    }
  });
}

const SYM_PICKER_PAGE_SIZE = 8;

export async function sendSymbolPicker(ctx: BotContext, side: "long" | "short"): Promise<void> {
  await sendSymbolPickerPage(ctx, side, 0, false);
}

export async function sendSymbolPickerPage(
  ctx: BotContext,
  side: "long" | "short",
  page: number,
  edit: boolean,
): Promise<void> {
  const allMarkets = await getMarkets();
  const {
    items: slice,
    page: safePage,
    totalPages,
  } = paginate(allMarkets, page, SYM_PICKER_PAGE_SIZE);

  const snaps = await Promise.allSettled(slice.map((m) => getMarketSnapshot(m.symbol)));

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";
  const botUsername = ctx.me.username ?? "bot";

  const pageLabel =
    totalPages > 1 ? fmt`  ·  ${FormattedString.i(`Page ${safePage + 1}/${totalPages}`)}` : fmt``;

  const header = fmt`${emoji} ${FormattedString.b(`${label} — pick a market`)}${pageLabel}`;

  const rows = slice.map((m, i) => {
    const snap = snaps[i].status === "fulfilled" ? snaps[i].value : null;
    const maxLev = snap?.maxLeverage ?? m.leverageTiers[0]?.maxLeverage ?? 20;
    const isoTag = isIsolatedOnly(m.symbol) ? " [ISO]" : "";
    const globalIdx = safePage * SYM_PICKER_PAGE_SIZE + i + 1;
    const rowLabel = `${globalIdx}. ${m.symbol}${isoTag} · ${maxLev}×`;
    const deepLink = `https://t.me/${botUsername}?start=${side}_${m.symbol}_${safePage}`;
    if (!snap) return fmt`${FormattedString.link(rowLabel, deepLink)}   —`;
    return fmt`${FormattedString.link(rowLabel, deepLink)}   ${FormattedString.b(fmtPrice(snap.markPrice))}`;
  });

  const msg = FormattedString.join([header, fmt``, ...rows], "\n");

  const kb = new InlineKeyboard();
  addPaginationRow(kb, `trade_sym:${side}`, safePage, totalPages);
  kb.text("✕ Cancel", "cancel");

  const opts = {
    entities: msg.entities,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  };

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

export async function sendSizeStep(
  ctx: BotContext,
  side: "long" | "short",
  symbol: string,
): Promise<void> {
  if (!ctx.user) return;

  if (isIsolatedOnly(symbol)) {
    const msg = fmt`⚠️ ${FormattedString.b(symbol)} needs an isolated margin account — not available yet.\n\nUse /markets to find other markets.`;
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

  const state = await getTraderState(ctx.user.walletAddress);
  const available = Number(state.effectiveCollateral);
  if (available <= 0) {
    const kb = new InlineKeyboard().text("📥 Deposit USDC", "nav:deposit");
    const msg = fmt`You have no funds to trade with.\n\nDeposit USDC to get started.`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
    return;
  }

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";
  const totalFeeRate = snapshot.takerFee + config.BUILDER_FEE_BPS / 10_000;
  const maxSafeMargin = available / (1 + snapshot.maxLeverage * totalFeeRate);
  const kb = sizePickerKeyboard(side, symbol, maxSafeMargin);

  const msg = fmt`${emoji} ${FormattedString.b(`${label} ${symbol}`)}  ·  ${fmtPrice(snapshot.markPrice)}\n\nYour balance: ${FormattedString.b(usd(available))}\n\nHow much do you want to risk?`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendLevStep(
  ctx: BotContext,
  side: "long" | "short",
  symbol: string,
  sizeUsdc: number,
): Promise<void> {
  if (!ctx.user) return;

  let snapshot: Awaited<ReturnType<typeof getMarketSnapshot>>;
  try {
    snapshot = await getMarketSnapshot(symbol);
  } catch {
    await ctx.reply(`Market "${symbol}" not found. Use /markets to browse.`);
    return;
  }

  const settings = (await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, ctx.user.id),
  })) ?? { defaultLeverage: 5 };

  const state = await getTraderState(ctx.user.walletAddress);
  const available = Number(state.effectiveCollateral);
  const totalFeeRate = snapshot.takerFee + config.BUILDER_FEE_BPS / 10_000;
  const maxSafeMargin = available / (1 + snapshot.maxLeverage * totalFeeRate);
  if (sizeUsdc > maxSafeMargin + 0.01) {
    const kb = new InlineKeyboard().text("← Pick size", `trade:${side}:${symbol}`);
    const msg =
      sizeUsdc > available
        ? fmt`${FormattedString.b(usd(sizeUsdc))} exceeds your available balance of ${FormattedString.b(usd(available))}. Enter a smaller amount.`
        : fmt`${FormattedString.b(usd(sizeUsdc))} leaves no room for fees (max at ${snapshot.maxLeverage}×: ${FormattedString.b(usd(maxSafeMargin))}). Enter a smaller amount.`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
    return;
  }

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";

  let fundingNote = fmt``;
  const isLongPaying = snapshot.fundingRate > 0;
  const youPay = side === "long" ? isLongPaying : !isLongPaying;
  const dailyAtDefault = Math.abs(snapshot.fundingRate) * sizeUsdc * settings.defaultLeverage * 3;
  if (dailyAtDefault > 0.05) {
    const verb = youPay ? "costs you" : "earns you";
    const dailyStr = fundingDailyUsd(snapshot.fundingRate, sizeUsdc * settings.defaultLeverage);
    fundingNote = fmt`\n💸 Funding ${verb} ≈${FormattedString.b(dailyStr)} at ${settings.defaultLeverage}× (varies by leverage)\n`;
  }

  const kb = leveragePickerKeyboard(
    side,
    symbol,
    sizeUsdc,
    snapshot.maxLeverage,
    settings.defaultLeverage,
  );

  const msg = fmt`${emoji} ${FormattedString.b(`${label} ${symbol}`)}  ·  risking ${FormattedString.b(usd(sizeUsdc))}\n${fundingNote}\nPick your multiplier — buttons show what you'd control:`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendTradeConfirm(
  ctx: BotContext,
  side: "long" | "short",
  symbol: string,
  lev: number,
  sizeUsdc: number,
  edit = false,
): Promise<void> {
  if (!ctx.user) return;

  let pf: PreflightResult;
  try {
    pf = await preflightOpen({
      user: ctx.user,
      symbol,
      side,
      marginUsdc: sizeUsdc,
      leverage: lev,
    });
  } catch (e) {
    await renderBotError(ctx, e, { action: "Open trade" });
    return;
  }

  const { snapshot, effectiveLeverage, notional, feeUsdc, liqPrice, totalCost } = pf;
  const entry = snapshot.markPrice;
  const feePct = ((feeUsdc / notional) * 100).toFixed(3);

  const liqLine = liqDistanceLabel(side, entry, liqPrice);

  const isLongPaying = snapshot.fundingRate > 0;
  const youPay = side === "long" ? isLongPaying : !isLongPaying;
  const dailyCost = Math.abs(snapshot.fundingRate) * notional * 3;
  let fundingLine = fmt``;
  if (dailyCost > 0.01) {
    if (youPay) {
      fundingLine = fmt`\n💸 Daily holding cost:  ${FormattedString.b(`$${dailyCost.toFixed(2)}/day`)}`;
    } else {
      fundingLine = fmt`\n💰 Daily funding income:  ${FormattedString.b(`$${dailyCost.toFixed(2)}/day`)} (rate in your favour)`;
    }
  }

  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";
  const anchorStr = entry.toPrecision(12);

  const kb = new InlineKeyboard()
    .text(
      `✅ ${label} ${usd(notional, 0, 0)} of ${symbol}`,
      `confirm:${side}:${symbol}:${effectiveLeverage}:${sizeUsdc}:${anchorStr}`,
    )
    .row()
    .text("✕ Cancel", "cancel");

  const msg = fmt`📋 ${FormattedString.b("Open trade")}\n\n${emoji} ${FormattedString.b(`${label} ${symbol}`)}  (${effectiveLeverage}×)\n\nYou risk:       ${FormattedString.b(usd(sizeUsdc))}\nYou control:    ${FormattedString.b(usd(notional))} of ${symbol}\nEntry near:     ${FormattedString.b(`~${fmtPrice(entry)}`)}\n\nFee:            ${FormattedString.b(`${usd(feeUsdc)} (${feePct}%)`)}\nYou pay:        ${FormattedString.b(usd(totalCost))}${fundingLine}\n\nStop-out if price ${liqLine}\n\n${FormattedString.i("(Quote based on current price)")}`;

  const opts = {
    entities: msg.entities,
    reply_markup: kb,
  };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}
