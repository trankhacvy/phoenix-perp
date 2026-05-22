import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { type TradeHistoryEntry, getTradeHistory } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";
import { cryptoSize, price as fmtPrice, solscanUrl, usd } from "../lib/fmt.js";
import { addPaginationRow, paginate } from "../lib/paginate.js";

const PAGE_SIZE = 5;
const FETCH_LIMIT = 30;

function tradeAction(instructionType: string, side: "long" | "short"): string {
  if (instructionType === "ReduceOnly") {
    return side === "short" ? "Close Long" : "Close Short";
  }
  return side === "long" ? "Open Long" : "Open Short";
}

function orderType(instructionType: string): string | null {
  if (instructionType === "ReduceOnly") return null;
  const lower = instructionType.toLowerCase();
  if (lower.includes("market")) return "Market";
  if (lower.includes("limit") || lower.includes("post")) return "Limit";
  return null;
}

function isClose(t: TradeHistoryEntry): boolean {
  return t.instructionType === "ReduceOnly";
}

function pnlEmoji(n: number): string {
  return n >= 0 ? "🟢" : "🔴";
}

function signedUsd(n: number): string {
  return n >= 0 ? `+${usd(n)}` : usd(n);
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
  allTrades: TradeHistoryEntry[],
  page: number,
  totalPages: number,
  botUsername: string,
): FormattedString {
  const totalRealizedPnl = allTrades
    .filter(isClose)
    .reduce((sum, t) => sum + Number(t.realizedPnl), 0);

  const pageLabel =
    totalPages > 1 ? fmt`  ·  ${FormattedString.i(`Page ${page + 1}/${totalPages}`)}` : fmt``;
  const header = fmt`📋 ${FormattedString.b("Trade History")}${pageLabel}\nRealized PnL: ${FormattedString.b(signedUsd(totalRealizedPnl))} ${pnlEmoji(totalRealizedPnl)}`;

  const rows = pageItems.map((t, localIdx) => {
    const globalIdx = page * PAGE_SIZE + localIdx;
    const action = tradeAction(t.instructionType, t.side);
    const ot = orderType(t.instructionType);
    const otPart = ot ? ` · ${ot}` : "";
    const size = cryptoSize(Number(t.size), t.symbol);
    const tradeValue = Number(t.price) * Number(t.size);
    const deepLink = `https://t.me/${botUsername}?start=hist_${globalIdx}_${page}`;

    // Link text: "1. SOL · Open Long · Market"  timestamp floats to the right on the same line
    const titleLine = fmt`${FormattedString.link(`${localIdx + 1}. ${t.symbol} · ${action}${otPart}`, deepLink)} \t\t\t\t\t\t${FormattedString.i(formatTs(t.timestamp))}`;

    const pnl = Number(t.realizedPnl);
    // Opens: show value (bet size). Closes: show P&L — the number traders care about.
    const metricPart = isClose(t)
      ? fmt`P&L: ${FormattedString.b(signedUsd(pnl))} ${pnlEmoji(pnl)}`
      : fmt`Value: ${FormattedString.b(usd(tradeValue))}`;

    const detailLine = fmt`Size: ${FormattedString.b(size)}  ·  Price: ${FormattedString.b(fmtPrice(Number(t.price)))}  ·  ${metricPart}`;

    return FormattedString.join([titleLine, detailLine], "\n");
  });

  return FormattedString.join([header, ...rows], "\n\n");
}

function buildListKeyboard(page: number, totalPages: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  addPaginationRow(kb, "hist:list", page, totalPages);
  kb.text("📊 Positions", "nav:positions").text("💰 Balance", "nav:balance");
  return kb;
}

// ─── Detail view ─────────────────────────────────────────────────────────────

function buildDetailText(t: TradeHistoryEntry): FormattedString {
  const action = tradeAction(t.instructionType, t.side);
  const ot = orderType(t.instructionType);
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

export async function sendHistoryScreen(ctx: BotContext, page = 0, edit = false): Promise<void> {
  if (!ctx.user) return;
  const history = await getTradeHistory(ctx.user.walletAddress, FETCH_LIMIT);

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
  const msg = buildListText(items, history.trades, safePage, totalPages, botUsername);
  const kb = buildListKeyboard(safePage, totalPages);
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
      await ctx.reply("Type /start first.");
      return;
    }
    await sendHistoryScreen(ctx);
  });

  bot.callbackQuery(/^hist:list:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendHistoryScreen(ctx, Number(ctx.match[1]), true);
  });

  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
