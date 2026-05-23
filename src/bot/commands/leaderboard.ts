import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot, CallbackQueryContext } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  type LeaderboardSortBy,
  getLeaderboard,
  getLeaderboardStats,
} from "../../services/leaderboard.js";
import type { BotContext } from "../../types/index.js";
import { compactUsd, pnlEmoji, shortAddr, signedUsd, timeAgo } from "../lib/fmt.js";

const PAGE_SIZE = 10;

const VALID_SORT_KEYS = new Set<LeaderboardSortBy>([
  "portfolio_value",
  "realized_pnl",
  "total_volume",
]);

function parseSortBy(raw: string): LeaderboardSortBy {
  return VALID_SORT_KEYS.has(raw as LeaderboardSortBy)
    ? (raw as LeaderboardSortBy)
    : "portfolio_value";
}

const SORT_LABELS: Record<LeaderboardSortBy, string> = {
  portfolio_value: "Portfolio",
  realized_pnl: "Realized PnL",
  total_volume: "Volume",
};

function buildLeaderboardMessage(
  rows: Awaited<ReturnType<typeof getLeaderboard>>["rows"],
  sortBy: LeaderboardSortBy,
  page: number,
  totalPages: number,
  totalTraders: number,
  lastUpdated: Date | null,
) {
  const pageLabel =
    totalPages > 1 ? fmt`  ·  ${FormattedString.i(`${page + 1}/${totalPages}`)}` : fmt``;

  const header = fmt`🏆 ${FormattedString.b("Leaderboard")}  ·  ${FormattedString.i(SORT_LABELS[sortBy])}${pageLabel}`;

  const lines: FormattedString[] = [header, fmt``];

  if (rows.length === 0) {
    lines.push(fmt`${FormattedString.i("No trader data available yet. Check back soon.")}`);
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rank = page * PAGE_SIZE + i + 1;
    const addr = FormattedString.code(shortAddr(r.walletAddress));

    let metric: string;
    if (sortBy === "portfolio_value") {
      metric = compactUsd(Number(r.portfolioValue));
    } else if (sortBy === "realized_pnl") {
      metric = signedUsd(Number(r.realizedPnl ?? 0));
    } else {
      metric = compactUsd(Number(r.totalVolume ?? 0));
    }

    const pnl = Number(r.unrealizedPnl);
    const pnlStr = pnl !== 0 ? `  ${pnlEmoji(pnl)} ${signedUsd(pnl)}` : "";
    const posStr = r.positionCount > 0 ? `  ${r.positionCount} pos` : "";

    lines.push(
      fmt`${FormattedString.b(`${rank}.`)} ${addr}   ${FormattedString.b(metric)}${pnlStr}${posStr}`,
    );
  }

  if (lastUpdated) {
    const ago = timeAgo(lastUpdated.getTime());
    lines.push(fmt``);
    lines.push(fmt`${FormattedString.i(`${totalTraders} traders tracked · Updated ${ago}`)}`);
  }

  return FormattedString.join(lines, "\n");
}

function buildKeyboard(sortBy: LeaderboardSortBy, page: number, totalPages: number) {
  const kb = new InlineKeyboard();

  for (const [key, label] of Object.entries(SORT_LABELS)) {
    const active = key === sortBy ? `[${label}]` : label;
    kb.text(active, `lb:sort:${key}:0`);
  }
  kb.row();

  if (totalPages > 1) {
    if (page > 0) kb.text("← Prev", `lb:page:${sortBy}:${page - 1}`);
    kb.text(`${page + 1} / ${totalPages}`, "noop");
    if (page < totalPages - 1) kb.text("Next →", `lb:page:${sortBy}:${page + 1}`);
  }

  return kb;
}

async function sendLeaderboardPage(
  ctx: BotContext | CallbackQueryContext<BotContext>,
  sortBy: LeaderboardSortBy,
  page: number,
  edit: boolean,
) {
  const [data, stats] = await Promise.all([
    getLeaderboard(sortBy, page, PAGE_SIZE),
    getLeaderboardStats(),
  ]);

  const msg = buildLeaderboardMessage(
    data.rows,
    sortBy,
    data.page,
    data.totalPages,
    stats.totalTraders,
    stats.lastUpdated,
  );

  const kb = buildKeyboard(sortBy, data.page, data.totalPages);

  const opts = {
    entities: msg.entities,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  };

  if (edit && "editMessageText" in ctx) {
    await (ctx as CallbackQueryContext<BotContext>).editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

export function registerLeaderboard(bot: Bot<BotContext>) {
  bot.command("leaderboard", async (ctx) => {
    await sendLeaderboardPage(ctx, "portfolio_value", 0, false);
  });

  bot.callbackQuery(/^lb:page:(\w+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const sortBy = parseSortBy(ctx.match[1]);
    const page = Number(ctx.match[2]);
    await sendLeaderboardPage(ctx, sortBy, page, true);
  });

  bot.callbackQuery(/^lb:sort:(\w+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const sortBy = parseSortBy(ctx.match[1]);
    const page = Number(ctx.match[2]);
    await sendLeaderboardPage(ctx, sortBy, page, true);
  });
}
