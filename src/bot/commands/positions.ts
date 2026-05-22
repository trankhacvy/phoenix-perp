import type { Bot } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import { closePosition, addMargin } from "../../services/phoenix/trade.js";
import { getKitSigner } from "../../services/wallet.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { generatePnlCard } from "../../services/image.js";
import { positionKeyboard } from "../keyboards/position.js";
import { setPending } from "../lib/pending.js";
import { usd, price as fmtPrice, cryptoSize, solscanUrl } from "../lib/fmt.js";
import type { BotContext } from "../../types/index.js";
import { logger } from "../../lib/logger.js";
import { sendSlPrompt } from "./setsl.js";
import { sendTpPrompt } from "./settp.js";

export async function sendPositionsScreen(ctx: BotContext): Promise<void> {
  const state = await getTraderState(ctx.user!.walletAddress);
  const positions = state.positions ?? [];

  if (positions.length === 0) {
    const kb = new InlineKeyboard()
      .text("🟢 Buy / Long", "nav:long")
      .text("🔴 Sell / Short", "nav:short");
    await ctx.reply("You have no open positions.\n\nReady to trade?", { reply_markup: kb });
    return;
  }

  const botInfo = await ctx.api.getMe();
  const username = botInfo.username;

  const lines = positions.map((pos) => {
    const upnl = Number(pos.unrealizedPnl);
    const pnlSign = upnl >= 0 ? "+" : "";
    const emoji = pos.side === "long" ? "🟢" : "🔴";
    const label = pos.side === "long" ? "Long" : "Short";
    const size = cryptoSize(Number(pos.size), pos.symbol);
    const deepLink = `https://t.me/${username}?start=pos_${pos.symbol}_${pos.side}`;
    return fmt`${FormattedString.link(`${emoji} ${pos.symbol} ${label}`, deepLink)}  ${size}  ·  @${fmtPrice(Number(pos.markPrice))}  ·  P&L: ${FormattedString.b(`${pnlSign}${usd(upnl)}`)}`;
  });

  const kb = new InlineKeyboard()
    .text("🟢 New Long", "nav:long")
    .text("🔴 New Short", "nav:short");

  const header = fmt`📊 ${FormattedString.b(`Positions (${positions.length})`)}`;
  const footer = fmt`${FormattedString.i("Tap a position name to manage it.")}`;
  const msg = FormattedString.join([header, fmt``, ...lines, fmt``, footer], "\n");

  await ctx.reply(msg.text, {
    entities: msg.entities,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

export async function sendPositionDetail(ctx: BotContext, symbol: string, side: "long" | "short"): Promise<void> {
  const state = await getTraderState(ctx.user!.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);

  if (!pos) {
    await ctx.reply(`No open ${symbol} ${side} position found.`);
    return;
  }

  const upnl = Number(pos.unrealizedPnl);
  const pnlSign = upnl >= 0 ? "+" : "";
  const emoji = side === "long" ? "🟢" : "🔴";
  const label = side === "long" ? "Long" : "Short";
  const liqLabel = pos.liquidationPrice === "N/A" ? "Safe" : fmtPrice(Number(pos.liquidationPrice));

  const msg = fmt`${emoji} ${FormattedString.b(`${pos.symbol}/USD — ${label}`)}\n\nSize       ${FormattedString.b(cryptoSize(Number(pos.size), pos.symbol))}\nEntry      ${FormattedString.b(fmtPrice(Number(pos.entryPrice)))}\nMark       ${FormattedString.b(fmtPrice(Number(pos.markPrice)))}\nP&L       ${FormattedString.b(`${pnlSign}${usd(upnl)}`)}\nLiq price  ${FormattedString.b(liqLabel)}`;

  await ctx.reply(msg.text, {
    entities: msg.entities,
    reply_markup: positionKeyboard(pos.symbol, pos.side),
  });
}

export function registerPositions(bot: Bot<BotContext>) {
  bot.command("positions", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    await sendPositionsScreen(ctx);
  });

  bot.callbackQuery(/^close:([A-Z0-9]+):(\d+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, pctStr, side] = ctx.match.slice(1) as [string, string, "long" | "short"];
    const fraction = Number(pctStr);
    const state = await getTraderState(ctx.user.walletAddress);
    const pos = state.positions.find((p) => p.symbol === symbol);

    const sizeNote = pos
      ? fmt`\n${symbol} ${side} — closing ${FormattedString.b(`${fraction}%`)} at ~${fmtPrice(Number(pos.markPrice))}`
      : fmt``;

    const label = fraction === 100 ? "Close all" : `Close ${fraction}%`;
    const kb = new InlineKeyboard()
      .text(`✅ ${label}`, `close:exec:${symbol}:${fraction}:${side}`)
      .text("✕ Cancel", "cancel");

    const msg = fmt`Confirm close?${sizeNote}`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^close:exec:([A-Z0-9]+):(\d+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Closing…");
    if (!ctx.user) return;
    const [symbol, pctStr, side] = ctx.match.slice(1) as [string, string, "long" | "short"];
    const fraction = Number(pctStr) / 100;

    const state = await getTraderState(ctx.user.walletAddress);
    const pos = state.positions.find((p) => p.symbol === symbol);

    try {
      const sig = await closePosition(
        symbol,
        ctx.user.walletAddress,
        getKitSigner(ctx.user.walletAddress),
        fraction,
      );
      const msg = fmt`✅ ${FormattedString.b("Position closed")}\n\n${symbol} — ${FormattedString.b(`${fraction * 100}%`)} closed\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}`;
      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        link_preview_options: { is_disabled: true },
      });

      if (pos) {
        try {
          const pnl = Number(pos.unrealizedPnl) * fraction;
          const roiPct = (
            ((Number(pos.markPrice) - Number(pos.entryPrice)) / Number(pos.entryPrice)) *
            100 *
            (side === "long" ? 1 : -1)
          ).toFixed(2);
          const botInfo = await ctx.api.getMe();
          const card = await generatePnlCard({
            symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: pos.markPrice,
            roiPercent: roiPct,
            pnlUsdc: String(pnl.toFixed(2)),
            botHandle: `@${botInfo.username ?? "PhoenixPerpBot"}`,
          });
          const caption = fmt`${side === "long" ? "🟢" : "🔴"} ${FormattedString.b(`${symbol} ${side === "long" ? "Long" : "Short"}`)}\nP&L: ${FormattedString.b(usd(pnl))}  ROI: ${FormattedString.b(`${roiPct}%`)}`;
          await ctx.replyWithPhoto(new InputFile(card, "pnl.png"), {
            caption: caption.caption,
            caption_entities: caption.caption_entities,
          });
        } catch (cardErr) {
          logger.error({ err: cardErr, symbol }, "PnL card generation failed");
        }
      }
    } catch (e) {
      logger.error({ err: e, symbol, fraction }, "closePosition failed");
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      const msg = fmt`❌ Close failed: ${FormattedString.code(errMsg)}`;
      const kb = new InlineKeyboard().text("← Back", "nav:positions");
      await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
    }
  });

  bot.callbackQuery(/^margin:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const symbol = ctx.match[1];
    const state = await getTraderState(ctx.user.walletAddress);
    const available = Number(state.effectiveCollateral);
    const pos = state.positions.find((p) => p.symbol === symbol);
    const liqLabel =
      pos?.liquidationPrice === "N/A" ? "Safe" : fmtPrice(Number(pos?.liquidationPrice ?? 0));

    const msg = fmt`💰 ${FormattedString.b(`Add Margin — ${symbol}`)}\n\nAvailable:         ${FormattedString.code(usd(available))}\nCurrent liq price: ${FormattedString.code(liqLabel)}\n\nHow much do you want to add? (USD)`;
    await ctx.reply(msg.text, { entities: msg.entities });
    await setPending(ctx.from.id, `addmargin:${symbol}`);
  });

  bot.callbackQuery(/^addmargin:exec:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Adding…");
    if (!ctx.user) return;
    const [symbol, amtStr] = ctx.match.slice(1) as [string, string];
    const amount = Number(amtStr);
    try {
      await addMargin(symbol, ctx.user.walletAddress, amount, getKitSigner(ctx.user.walletAddress));
      const msg = fmt`✅ Added ${FormattedString.b(usd(amount))} margin to ${symbol}.`;
      await ctx.editMessageText(msg.text, { entities: msg.entities });
    } catch (e) {
      logger.error({ err: e, symbol, amount }, "addMargin failed");
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      const msg = fmt`❌ Failed to add margin: ${FormattedString.code(errMsg)}`;
      await ctx.editMessageText(msg.text, { entities: msg.entities });
    }
  });

  bot.callbackQuery(/^editsl:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    await sendSlPrompt(ctx, symbol, side);
  });

  bot.callbackQuery(/^edittp:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    await sendTpPrompt(ctx, symbol, side);
  });
}
