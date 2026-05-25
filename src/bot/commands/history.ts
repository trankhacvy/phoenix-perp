import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { type TradeHistoryEntry, getTradeHistory } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";
import {
  cryptoSize,
  price as fmtPrice,
  pnlEmoji,
  shortAddr,
  signedUsd,
  solscanUrl,
  usd,
} from "../lib/fmt.js";
import { addPaginationRow, paginate } from "../lib/paginate.js";

const PAGE_SIZE = 5;
const FETCH_LIMIT = 30;

function isClose(t: TradeHistoryEntry): boolean {
  return Number(t.realizedPnl) !== 0;
}

function tradeAction(t: TradeHistoryEntry): string {
  if (isClose(t)) {
    const base = t.side === "short" ? "Close Long" : "Close Short";
    if (t.instructionType === "ExecuteStopLoss") return `${base} · SL`;
    if (t.instructionType === "ExecuteTakeProfit") return `${base} · TP`;
    return base;
  }
  return t.side === "long" ? "Open Long" : "Open Short";
}

function orderType(t: TradeHistoryEntry): string | null {
  if (isClose(t)) return null;
  if (t.instructionType === "UncrossCrank") return "Limit";
  if (t.instructionType === "PlaceMarketOrder") return "Market";
  return null;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = d.getUTCHours();
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const h12 = hh % 12 || 12;
  const ampm = hh >= 12 ? "PM" : "AM";
  return `${mm}/${dd}  ${h12}:${min} ${ampm}`;
}

// ─── List view ────────────────────────────────────────────────────────────────

function buildListText(
  pageItems: TradeHistoryEntry[],
  totalRealizedPnl: number,
  page: number,
  totalPages: number,
  botUsername: string,
  external: boolean,
  walletAddress?: string,
): FormattedString {
  const pageLabel =
    totalPages > 1 ? fmt`  ·  ${FormattedString.i(`Page ${page + 1}/${totalPages}`)}` : fmt``;
  const walletLabel =
    external && walletAddress ? fmt` · ${FormattedString.code(shortAddr(walletAddress))}` : fmt``;
  const header = fmt`📋 ${FormattedString.b("Trade History")}${walletLabel}${pageLabel}\nRealized PnL: ${FormattedString.b(signedUsd(totalRealizedPnl))} ${pnlEmoji(totalRealizedPnl)}`;

  const rows = pageItems.map((t, localIdx) => {
    const globalIdx = page * PAGE_SIZE + localIdx;
    const action = tradeAction(t);
    const ot = orderType(t);
    const otPart = ot ? ` · ${ot}` : "";
    const size = cryptoSize(Number(t.size), t.symbol);
    const tradeValue = Number(t.price) * Number(t.size);
    const deepLink = external
      ? undefined
      : `https://t.me/${botUsername}?start=hist_${globalIdx}_${page}`;

    const titleText = `${localIdx + 1}. ${t.symbol} · ${action}${otPart}`;
    const titleLine = deepLink
      ? fmt`${FormattedString.link(titleText, deepLink)}\n${FormattedString.i(formatTs(t.timestamp))}`
      : fmt`${FormattedString.b(titleText)}\n${FormattedString.i(formatTs(t.timestamp))}`;

    const pnl = Number(t.realizedPnl);
    const metricPart = isClose(t)
      ? fmt`P&L: ${FormattedString.b(signedUsd(pnl))} ${pnlEmoji(pnl)}`
      : fmt`Value: ${FormattedString.b(usd(tradeValue))}`;

    const detailLine = fmt`Size: ${FormattedString.b(size)}  ·  Price: ${FormattedString.b(fmtPrice(Number(t.price)))}  ·  ${metricPart}`;

    return FormattedString.join([titleLine, detailLine], "\n");
  });

  return FormattedString.join([header, ...rows], "\n\n");
}

function buildListKeyboard(
  page: number,
  totalPages: number,
  prefix: string,
  external: boolean,
  walletAddress?: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  addPaginationRow(kb, prefix, page, totalPages);
  if (!external) {
    kb.text("📊 Positions", "nav:positions").text("📊 Portfolio", "nav:balance");
  } else if (walletAddress) {
    kb.text("← Trader", `walletinfo:back:${walletAddress}`);
  }
  return kb;
}

// ─── Detail view ─────────────────────────────────────────────────────────────

function buildDetailText(t: TradeHistoryEntry): FormattedString {
  const action = tradeAction(t);
  const ot = orderType(t);
  const size = cryptoSize(Number(t.size), t.symbol);
  const tradeValue = Number(t.price) * Number(t.size);
  const pnl = Number(t.realizedPnl);

  const lines: FormattedString[] = [
    fmt`${FormattedString.b(`${t.symbol} · ${action}`)}  (${ot ?? "Market"})`,
    fmt`━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ];

  if (isClose(t)) {
    lines.push(fmt`Realized PnL   ${FormattedString.b(signedUsd(pnl))} ${pnlEmoji(pnl)}`);
    lines.push(fmt``);
  }

  lines.push(
    fmt`Size    ${FormattedString.b(`${size}  (${usd(tradeValue)})`)}`,
    fmt`Price   ${FormattedString.b(fmtPrice(Number(t.price)))}`,
  );

  if (t.fee && Number(t.fee) > 0) {
    lines.push(fmt`Fee     ${FormattedString.b(usd(Number(t.fee)))}`);
  }

  lines.push(fmt``, fmt`${FormattedString.i(formatTs(t.timestamp))}`);

  return FormattedString.join(lines, "\n");
}

function buildDetailKeyboard(sig: string, fromPage: number): InlineKeyboard {
  const kb = new InlineKeyboard().text("← History", `hist:list:${fromPage}`);
  if (sig) kb.url("Solscan ↗", solscanUrl(sig));
  return kb;
}

// ─── Exported screen handlers ─────────────────────────────────────────────────

export async function sendHistoryScreen(
  ctx: BotContext,
  page = 0,
  edit = false,
  walletAddress?: string,
): Promise<void> {
  const targetWallet = walletAddress ?? ctx.user?.walletAddress;
  if (!targetWallet) return;
  const external = !!walletAddress && walletAddress !== ctx.user?.walletAddress;

  const history = await getTradeHistory(targetWallet, FETCH_LIMIT);

  if (history.trades.length === 0) {
    const text = "No trades yet.";
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text);
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const { items, page: safePage, totalPages } = paginate(history.trades, page, PAGE_SIZE);
  const botUsername = ctx.me.username ?? "bot";
  const prefix = external ? `walletinfo:hist:${walletAddress}` : "hist:list";
  const totalRealizedPnl = history.trades
    .filter(isClose)
    .reduce((sum, t) => sum + Number(t.realizedPnl), 0);
  const msg = buildListText(
    items,
    totalRealizedPnl,
    safePage,
    totalPages,
    botUsername,
    external,
    targetWallet,
  );
  const kb = buildListKeyboard(safePage, totalPages, prefix, external, targetWallet);
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

export async function sendHistoryDetail(
  ctx: BotContext,
  globalIdx: number,
  fromPage: number,
  edit = false,
): Promise<void> {
  if (!ctx.user) return;
  const history = await getTradeHistory(ctx.user.walletAddress, FETCH_LIMIT);
  const trade = history.trades[globalIdx];

  if (!trade) {
    const text = "Trade not found.";
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text);
    } else {
      await ctx.reply(text);
    }
    return;
  }

  const msg = buildDetailText(trade);
  const kb = buildDetailKeyboard(trade.signature, fromPage);
  const opts = { entities: msg.entities, reply_markup: kb };

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

export function registerHistory(bot: Bot<BotContext>) {
  bot.command("history", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }
    if (!(await requireActivation(ctx))) return;
    await sendHistoryScreen(ctx);
  });

  bot.callbackQuery(/^hist:list:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendHistoryScreen(ctx, Number(ctx.match[1]), true);
  });
}
