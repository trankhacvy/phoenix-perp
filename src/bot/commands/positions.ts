import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { InlineKeyboard, InputFile } from "grammy";
import type { Bot } from "grammy";
import { logger } from "../../lib/logger.js";
import { generatePnlCard } from "../../services/image.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { addMargin, closePosition } from "../../services/phoenix/trade.js";
import { getKitSigner } from "../../services/wallet.js";
import type { BotContext, PhoenixPosition } from "../../types/index.js";
import { positionKeyboard } from "../keyboards/position.js";
import { formatTradeError } from "../lib/errors.js";
import { cryptoSize, price as fmtPrice, num, solscanUrl, usd } from "../lib/fmt.js";
import { setPending } from "../lib/pending.js";
import { sendSlPrompt } from "./setsl.js";
import { sendTpPrompt } from "./settp.js";

const CIRCLE_NUMS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function circleNum(i: number): string {
  return CIRCLE_NUMS[i] ?? `${i + 1}.`;
}

function pnlColor(n: number): string {
  return n >= 0 ? "🟢" : "🔴";
}

function signedUsd(n: number): string {
  return n >= 0 ? `+${usd(n)}` : usd(n);
}

function signedPct(n: number, decimals = 2): string {
  return n >= 0 ? `+${num(n, decimals, decimals)}%` : `${num(n, decimals, decimals)}%`;
}

function calcPnlPct(pos: PhoenixPosition): number | null {
  const upnl = Number(pos.unrealizedPnl);
  const entry = Number(pos.entryPrice);
  const size = Number(pos.size);
  const lev = pos.leverage ?? 1;
  if (Number.isNaN(upnl) || Number.isNaN(entry) || Number.isNaN(size) || entry === 0) return null;
  const margin = (entry * size) / lev;
  return margin > 0 ? (upnl / margin) * 100 : null;
}

interface LiqInfo {
  distPct: number;
  warn: boolean;
}

function calcLiqInfo(pos: PhoenixPosition): LiqInfo | null {
  if (pos.liquidationPrice === "N/A") return null;
  const liq = Number(pos.liquidationPrice);
  const mark = Number(pos.markPrice);
  if (Number.isNaN(liq) || Number.isNaN(mark) || mark === 0 || liq <= 0) return null;
  const dist = pos.side === "long" ? ((mark - liq) / mark) * 100 : ((liq - mark) / mark) * 100;
  return { distPct: dist, warn: dist < 5 };
}

function formatLiqValue(pos: PhoenixPosition): { text: string; warn: boolean } {
  const info = calcLiqInfo(pos);
  if (!info) return { text: "Safe ✅", warn: false };
  return {
    text: `${fmtPrice(Number(pos.liquidationPrice))}  (–${num(info.distPct, 1, 1)}%)`,
    warn: info.warn,
  };
}

// ─── List view ────────────────────────────────────────────────────────────────

function buildListText(
  positions: PhoenixPosition[],
  totalUpnl: number,
  botUsername: string,
): FormattedString {
  const header = fmt`📊 ${FormattedString.b(`Open Positions (${positions.length})`)}   Total uPnL: ${FormattedString.b(signedUsd(totalUpnl))} ${pnlColor(totalUpnl)}`;

  const rows = positions.map((pos, i) => {
    const upnl = Number(pos.unrealizedPnl);
    const upnlPct = calcPnlPct(pos);
    const sideLabel = pos.side === "long" ? "LONG" : "SHORT";
    const levLabel = pos.leverage ? ` ${pos.leverage}x` : "";
    const pnlStr = upnlPct != null ? `${signedUsd(upnl)} (${signedPct(upnlPct)})` : signedUsd(upnl);
    const deepLink = `https://t.me/${botUsername}?start=pos_${pos.symbol}_${pos.side}`;
    const liq = formatLiqValue(pos);
    const warnTag = liq.warn ? " ⚠️" : "";

    return FormattedString.join(
      [
        FormattedString.link(`${circleNum(i)}  ${pos.symbol} - ${sideLabel}${levLabel}`, deepLink),
        fmt`   ${FormattedString.b(pnlStr)} ${pnlColor(upnl)}  |  Liq ${FormattedString.b(liq.text)}${warnTag}`,
      ],
      "\n",
    );
  });

  return FormattedString.join([header, ...rows], "\n\n");
}

function buildListKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Refresh", "pos:refresh")
    .row()
    .text("🟢 New Long", "nav:long")
    .text("🔴 New Short", "nav:short");
}

export async function sendPositionsScreen(ctx: BotContext, edit = false): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const positions = state.positions ?? [];

  if (positions.length === 0) {
    const kb = new InlineKeyboard()
      .text("🟢 Buy / Long", "nav:long")
      .text("🔴 Sell / Short", "nav:short");
    const text = "You have no open positions.\n\nReady to trade?";
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: kb });
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
    return;
  }

  const totalUpnl = Number(state.unrealizedPnl);
  const botUsername = ctx.me.username ?? "bot";
  const msg = buildListText(positions, totalUpnl, botUsername);
  const kb = buildListKeyboard();

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
  } else {
    await ctx.reply(msg.text, {
      entities: msg.entities,
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
  }
}

// ─── Detail view ─────────────────────────────────────────────────────────────

function buildDetailText(pos: PhoenixPosition, unsettledFunding: number): FormattedString {
  const upnl = Number(pos.unrealizedPnl);
  const upnlPct = calcPnlPct(pos);
  const sideLabel = pos.side === "long" ? "LONG" : "SHORT";
  const levLabel = pos.leverage ? ` · ${pos.leverage}x` : "";
  const marginLabel = pos.marginMode === "cross" ? "Cross" : "Isolated";
  const posValue = Number(pos.markPrice) * Number(pos.size);
  const pnlStr = upnlPct != null ? `${signedUsd(upnl)}  (${signedPct(upnlPct)})` : signedUsd(upnl);
  const liq = formatLiqValue(pos);
  const liqLine = fmt`${FormattedString.b(liq.text)}${liq.warn ? " ⚠️" : ""}`;

  const tpStr = pos.takeProfit ? fmtPrice(Number(pos.takeProfit)) : "—";
  const slStr = pos.stopLoss ? fmtPrice(Number(pos.stopLoss)) : "—";

  const lines: FormattedString[] = [
    fmt`${FormattedString.b(`${pos.symbol} · ${sideLabel}${levLabel}`)}  (${marginLabel})`,
    fmt`━━━━━━━━━━━━━━━━━━━━━━━━━`,
    fmt`Unrealized PnL   ${FormattedString.b(pnlStr)} ${pnlColor(upnl)}`,
    fmt``,
    fmt`Position size   ${FormattedString.b(`${cryptoSize(Number(pos.size), pos.symbol)}  (${usd(posValue)})`)}`,
    fmt`Entry price   ${FormattedString.b(fmtPrice(Number(pos.entryPrice)))}`,
    fmt`Mark price   ${FormattedString.b(fmtPrice(Number(pos.markPrice)))}`,
    fmt`Liq. price   ${liqLine}`,
    fmt``,
    fmt`Take profit   ${FormattedString.b(tpStr)}`,
    fmt`Stop loss     ${FormattedString.b(slStr)}`,
  ];

  if (Math.abs(unsettledFunding) > 0.001) {
    lines.push(fmt`Funding   ${FormattedString.b(signedUsd(unsettledFunding))}`);
  }

  return FormattedString.join(lines, "\n");
}

export async function sendPositionDetail(
  ctx: BotContext,
  symbol: string,
  side: "long" | "short",
  edit = false,
): Promise<void> {
  if (!ctx.user) return;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);

  if (!pos) {
    const text = `No open ${symbol} ${side} position found.`;
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text);
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const unsettledFunding = Number(state.unsettledFunding);
  const msg = buildDetailText(pos, unsettledFunding);
  const kb = positionKeyboard(symbol, side);

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: kb,
    });
  } else {
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  }
}

// ─── Command + callbacks ──────────────────────────────────────────────────────

export function registerPositions(bot: Bot<BotContext>) {
  bot.command("positions", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    await sendPositionsScreen(ctx);
  });

  // List navigation
  bot.callbackQuery("pos:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendPositionsScreen(ctx, true);
  });

  bot.callbackQuery("pos:refresh", async (ctx) => {
    await ctx.answerCallbackQuery("Refreshed");
    if (!ctx.user) return;
    await sendPositionsScreen(ctx, true);
  });

  // Detail navigation
  bot.callbackQuery(/^pos:detail:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    await sendPositionDetail(ctx, symbol, side, true);
  });

  bot.callbackQuery(/^pos:refresh:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Refreshed");
    if (!ctx.user) return;
    const [symbol, side] = ctx.match.slice(1) as [string, "long" | "short"];
    await sendPositionDetail(ctx, symbol, side, true);
  });

  // Close position — confirm prompt
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

    const confirmMsg = fmt`Confirm close?${sizeNote}`;
    await ctx.reply(confirmMsg.text, {
      entities: confirmMsg.entities,
      reply_markup: kb,
    });
  });

  // Close position — execute
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

      const closedPct = fraction * 100;
      const successMsg = fmt`✅ ${FormattedString.b("Position closed")}\n\n${symbol} — ${FormattedString.b(`${closedPct}%`)} closed\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}`;
      await ctx.editMessageText(successMsg.text, {
        entities: successMsg.entities,
        link_preview_options: { is_disabled: true },
      });

      if (pos) {
        try {
          const pnl = Number(pos.unrealizedPnl) * fraction;
          const leverage = pos.leverage ?? 1;
          const margin = (Number(pos.entryPrice) * Number(pos.size)) / Math.max(leverage, 1);
          const roiPct = margin > 0 ? ((pnl / margin) * 100).toFixed(2) : "0.00";
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
          const captionMsg = fmt`${side === "long" ? "🟢" : "🔴"} ${FormattedString.b(`${symbol} ${side === "long" ? "Long" : "Short"}`)}\nP&L: ${FormattedString.b(usd(pnl))}  ROI: ${FormattedString.b(`${roiPct}%`)}`;
          await ctx.replyWithPhoto(new InputFile(card, "pnl.png"), {
            caption: captionMsg.caption,
            caption_entities: captionMsg.caption_entities,
          });
        } catch (cardErr) {
          logger.error({ err: cardErr, symbol }, "PnL card generation failed");
        }
      }
    } catch (e) {
      logger.error({ err: e, symbol, fraction }, "closePosition failed");
      const kb = new InlineKeyboard().text("← Back", "nav:positions");
      await ctx.editMessageText(formatTradeError(e, "Close position"), {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    }
  });

  // Add margin — prompt
  bot.callbackQuery(/^margin:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const symbol = ctx.match[1];
    const state = await getTraderState(ctx.user.walletAddress);
    const available = Number(state.effectiveCollateral);
    const pos = state.positions.find((p) => p.symbol === symbol);
    const liqLabel =
      pos?.liquidationPrice === "N/A" ? "Safe" : fmtPrice(Number(pos?.liquidationPrice ?? 0));

    const promptMsg = fmt`💰 ${FormattedString.b(`Add Margin — ${symbol}`)}\n\nAvailable:         ${FormattedString.code(usd(available))}\nCurrent liq price: ${FormattedString.code(liqLabel)}\n\nHow much do you want to add? (USD)`;
    await ctx.reply(promptMsg.text, { entities: promptMsg.entities });
    await setPending(ctx.from.id, `addmargin:${symbol}`);
  });

  // Add margin — execute
  bot.callbackQuery(/^addmargin:exec:([A-Z0-9]+):([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Adding…");
    if (!ctx.user) return;
    const [symbol, amtStr] = ctx.match.slice(1) as [string, string];
    const amount = Number(amtStr);
    try {
      await addMargin(symbol, ctx.user.walletAddress, amount, getKitSigner(ctx.user.walletAddress));
      const doneMsg = fmt`✅ Added ${FormattedString.b(usd(amount))} margin to ${FormattedString.b(symbol)}.`;
      await ctx.editMessageText(doneMsg.text, { entities: doneMsg.entities });
    } catch (e) {
      logger.error({ err: e, symbol, amount }, "addMargin failed");
      await ctx.editMessageText(formatTradeError(e, "Add margin"), {
        parse_mode: "HTML",
      });
    }
  });

  // SL/TP edit callbacks
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
