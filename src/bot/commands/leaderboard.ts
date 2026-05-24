import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot, CallbackQueryContext } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  type LeaderboardSortBy,
  getLeaderboard,
  getLeaderboardStats,
} from "../../services/leaderboard.js";
import type { BotContext } from "../../types/index.js";
import { compactUsd, shortAddr, signedUsd, timeAgo } from "../lib/fmt.js";

const PAGE_SIZE = 10;

const VALID_SORT_KEYS = new Set<LeaderboardSortBy>(["total_volume", "win_rate", "realized_pnl"]);

function parseSortBy(raw: string): LeaderboardSortBy {
  return VALID_SORT_KEYS.has(raw as LeaderboardSortBy)
    ? (raw as LeaderboardSortBy)
    : "total_volume";
}

const SORT_LABELS: Record<LeaderboardSortBy, string> = {
  total_volume: "Vol",
  win_rate: "Win Rate",
  realized_pnl: "PnL",
};

function winRate(winCount: number | null, lossCount: number | null): number | null {
  const w = winCount ?? 0;
  const l = lossCount ?? 0;
  if (w + l === 0) return null;
  return (w / (w + l)) * 100;
}

function buildLeaderboardMessage(
  rows: Awaited<ReturnType<typeof getLeaderboard>>["rows"],
  sortBy: LeaderboardSortBy,
  page: number,
  totalPages: number,
  totalTraders: number,
  lastUpdated: Date | null,
  botUsername: string,
) {
  const pageLabel =
    totalPages > 1 ? fmt`  ·  ${FormattedString.i(`${page + 1}/${totalPages}`)}` : fmt``;

  const header = fmt`🏆 ${FormattedString.b("Leaderboard")}${pageLabel}\n`;

  const lines: FormattedString[] = [header];

  if (rows.length === 0) {
    lines.push(fmt`${FormattedString.i("No trader data available yet.")}`);
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rank = page * PAGE_SIZE + i + 1;
    const deepLink = `https://t.me/${botUsername}?start=wallet_${r.walletAddress}`;
    const meta = r.metadata as { name?: string; avatar?: string } | null;
    const displayName = meta?.name
      ? `${meta.avatar ?? ""} ${meta.name}`.trim()
      : shortAddr(r.walletAddress);
    const nameLink = FormattedString.link(displayName, deepLink);

    let metric: string;
    if (sortBy === "win_rate") {
      const wr = winRate(r.winCount, r.lossCount);
      metric = wr !== null ? `${wr.toFixed(1)}%` : "—";
    } else if (sortBy === "realized_pnl") {
      metric = signedUsd(Number(r.realizedPnl ?? 0));
    } else {
      metric = compactUsd(Number(r.totalVolume ?? 0));
    }

    lines.push(fmt`${FormattedString.b(`${rank}.`)} ${nameLink}      ${FormattedString.b(metric)}`);
  }

  if (totalTraders > 0) {
    const updatedStr = lastUpdated ? ` · Updated ${timeAgo(lastUpdated.getTime())}` : "";
    lines.push(fmt``);
    lines.push(fmt`${FormattedString.i(`${totalTraders} traders${updatedStr}`)}`);
  }

  return FormattedString.join(lines, "\n");
}

function buildKeyboard(sortBy: LeaderboardSortBy, page: number, totalPages: number) {
  const kb = new InlineKeyboard();

  for (const [key, label] of Object.entries(SORT_LABELS)) {
    const active = key === sortBy ? `${label} ✓` : label;
    kb.text(active, `lb:sort:${key}:0`);
  }
  kb.row();

  if (totalPages > 1) {
    if (page > 0) kb.text("← Prev", `lb:page:${sortBy}:${page - 1}`);
    kb.text(`${page + 1} / ${totalPages}`, "noop");
    if (page < totalPages - 1) kb.text("Next →", `lb:page:${sortBy}:${page + 1}`);
    kb.row();
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

  const botUsername = ctx.me.username ?? "bot";

  const msg = buildLeaderboardMessage(
    data.rows,
    sortBy,
    data.page,
    data.totalPages,
    stats.totalTraders,
    stats.lastUpdated,
    botUsername,
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
    await sendLeaderboardPage(ctx, "total_volume", 0, false);
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
