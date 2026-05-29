import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { and, eq } from "drizzle-orm";
import { type Bot, InputFile } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "../../db/index.js";
import { walletMonitors } from "../../db/schema/index.js";
import { type WalletMetadata, leaderboardSnapshots } from "../../db/schema/leaderboard.js";
import { MONITOR_EVENTS_CHANNEL } from "../../lib/constants.js";
import { redis } from "../../lib/redis.js";
import { generateWalletCard } from "../../services/image.js";
import { isIsolatedOnly } from "../../services/phoenix/market.js";
import {
  computeWalletAnalytics,
  fetchAllTradeHistory,
  getTraderState,
} from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";
import {
  compactUsd,
  price as fmtPrice,
  pnlEmoji,
  shortAddr,
  signedUsd,
  timeAgo,
  usd,
} from "../lib/fmt.js";
import { addPaginationRow, paginate } from "../lib/paginate.js";
import { referralBadgeData } from "../lib/referral-link.js";
import { BASE58_RE } from "../lib/validate.js";
import { sendHistoryScreen } from "./history.js";

const POS_PAGE_SIZE = 6;

// ── Short-lived caches for the wallet screen ──────────────────────────────────
// A viewer screen doesn't need per-second freshness. Cache the two expensive
// Phoenix REST reads so re-renders (pagination, follow/unfollow refresh) and the
// "Generate Card" tap don't re-fetch — the card otherwise re-pulls full history.
const STATE_TTL_MS = 20_000;
const ANALYTICS_TTL_MS = 60_000;
const CACHE_MAX = 500;

type WalletState = Awaited<ReturnType<typeof getTraderState>>;
type WalletAnalytics = ReturnType<typeof computeWalletAnalytics>;

function cacheSet<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= CACHE_MAX && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

const stateCache = new Map<string, { data: WalletState; ts: number }>();
const analyticsCache = new Map<string, { data: WalletAnalytics; ts: number }>();

async function getCachedState(address: string): Promise<WalletState> {
  const hit = stateCache.get(address);
  if (hit && Date.now() - hit.ts < STATE_TTL_MS) return hit.data;
  const data = await getTraderState(address);
  cacheSet(stateCache, address, { data, ts: Date.now() });
  return data;
}

async function getCachedAnalytics(address: string): Promise<WalletAnalytics> {
  const hit = analyticsCache.get(address);
  if (hit && Date.now() - hit.ts < ANALYTICS_TTL_MS) return hit.data;
  const trades = await fetchAllTradeHistory(address);
  const data = computeWalletAnalytics(trades);
  cacheSet(analyticsCache, address, { data, ts: Date.now() });
  return data;
}

function buildExternalPositionRow(
  pos: {
    symbol: string;
    side: "long" | "short";
    leverage?: number;
    entryPrice: string;
    markPrice: string;
    unrealizedPnl: string;
  },
  botUsername: string,
): FormattedString {
  const upnl = Number(pos.unrealizedPnl);
  const sideIcon = pos.side === "long" ? "🟢" : "🔴";
  const sideLabel = pos.side === "long" ? "LONG" : "SHORT";
  const levLabel = pos.leverage ? ` ${pos.leverage}x` : "";
  const counterSide = pos.side === "long" ? "short" : "long";
  const isolated = isIsolatedOnly(pos.symbol);
  const title = `${sideIcon} ${pos.symbol} · ${sideLabel}${levLabel}`;
  const titleLine = isolated
    ? FormattedString.b(title)
    : FormattedString.link(title, `https://t.me/${botUsername}?start=${pos.side}_${pos.symbol}`);
  const actionLinks = isolated
    ? fmt``
    : fmt`   ${FormattedString.link("Copy", `https://t.me/${botUsername}?start=${pos.side}_${pos.symbol}`)} · ${FormattedString.link("Counter", `https://t.me/${botUsername}?start=${counterSide}_${pos.symbol}`)}`;

  return FormattedString.join(
    [
      fmt`${titleLine}   ${FormattedString.b(signedUsd(upnl))} ${pnlEmoji(upnl)}`,
      fmt`   Entry ${FormattedString.b(fmtPrice(Number(pos.entryPrice)))}  →  ${FormattedString.b(fmtPrice(Number(pos.markPrice)))}${actionLinks}`,
    ],
    "\n",
  );
}

export async function sendWalletScreen(
  ctx: BotContext,
  walletAddress: string,
  chatId: number,
  loadingMsgId: number,
): Promise<void> {
  const isOwn = walletAddress === ctx.user?.walletAddress;

  const [state, analytics, lbRow] = await Promise.all([
    getCachedState(walletAddress),
    getCachedAnalytics(walletAddress),
    db.query.leaderboardSnapshots.findFirst({
      where: eq(leaderboardSnapshots.walletAddress, walletAddress),
    }),
  ]);

  const collateral = Number(state.effectiveCollateral);

  if (collateral === 0 && analytics.totalFills === 0) {
    await ctx.api.editMessageText(
      chatId,
      loadingMsgId,
      `No Phoenix activity found for ${shortAddr(walletAddress)}.`,
    );
    return;
  }

  const meta = lbRow?.metadata as WalletMetadata | null;
  const sections: FormattedString[] = [];

  const headerParts: FormattedString[] = [fmt`📊 ${FormattedString.code(walletAddress)}`];
  if (meta?.name) {
    const nameStr = `${meta.avatar ?? ""} ${meta.name}`.trim();
    headerParts.push(fmt`${FormattedString.b(nameStr)}`);
  }
  if (meta?.twitter) {
    headerParts.push(FormattedString.link(`@${meta.twitter}`, `https://x.com/${meta.twitter}`));
  }
  sections.push(FormattedString.join(headerParts, "\n"));

  // ── Portfolio ────────────────────────────────────────────────────────────────
  const openPnl = Number(state.unrealizedPnl);
  const posCount = state.positions.length;
  const posLabel = posCount === 0 ? "no positions" : `${posCount} open`;
  sections.push(
    FormattedString.join(
      [
        fmt`💼 ${FormattedString.b("Portfolio")}`,
        fmt`Collateral  ${FormattedString.b(usd(collateral))}`,
        fmt`Open P&L    ${FormattedString.b(signedUsd(openPnl))} ${pnlEmoji(openPnl)}  (${posLabel})`,
      ],
      "\n",
    ),
  );

  // ── Live Positions ──────────────────────────────────────────────────────────
  const positions = state.positions ?? [];
  const validPositions = positions.filter(
    (p) => Number(p.entryPrice) > 0 && Number(p.markPrice) > 0,
  );
  if (!isOwn && validPositions.length > 0) {
    const shown = validPositions.slice(0, 5);
    const botUsername = ctx.me.username ?? "bot";
    const posLines: FormattedString[] = [fmt`📍 ${FormattedString.b("Live Positions")}`];
    for (const pos of shown) {
      posLines.push(buildExternalPositionRow(pos, botUsername));
    }
    if (validPositions.length > shown.length) {
      posLines.push(fmt`${FormattedString.i(`+ ${validPositions.length - shown.length} more`)}`);
    }
    sections.push(FormattedString.join(posLines, "\n\n"));
  }

  // ── Performance ──────────────────────────────────────────────────────────────
  if (analytics.totalFills > 0) {
    const winPct =
      analytics.closedTrades > 0
        ? Math.round((analytics.wins / analytics.closedTrades) * 100)
        : null;
    const winStr =
      winPct !== null ? `${winPct}%  (${analytics.wins} / ${analytics.closedTrades} closes)` : "—";
    const longPct = Math.round((analytics.longCount / analytics.totalFills) * 100);
    const makerPct = Math.round((analytics.makerCount / analytics.totalFills) * 100);
    const lastStr = analytics.lastFillAt !== null ? timeAgo(analytics.lastFillAt) : "—";

    sections.push(
      FormattedString.join(
        [
          fmt`📈 ${FormattedString.b("All time")}  ·  ${analytics.totalFills} fills  ·  ${analytics.marketsCount} markets`,
          fmt`Realized P&L  ${FormattedString.b(signedUsd(analytics.realizedPnl))} ${pnlEmoji(analytics.realizedPnl)}`,
          fmt`Win rate      ${FormattedString.b(winStr)}`,
          fmt`Volume        ${FormattedString.b(compactUsd(analytics.totalVolume))}`,
          fmt`Last trade    ${FormattedString.b(lastStr)}`,
          fmt`Long / Short  ${FormattedString.b(`${longPct}% / ${100 - longPct}%`)}`,
          fmt`Maker         ${FormattedString.b(`${makerPct}%`)}`,
        ],
        "\n",
      ),
    );

    // ── Best / Worst ───────────────────────────────────────────────────────────
    if (analytics.bestTrade && analytics.worstTrade) {
      sections.push(
        FormattedString.join(
          [
            fmt`🏆 ${FormattedString.b("Best")}   ${FormattedString.b(signedUsd(analytics.bestTrade.pnl))}   ${analytics.bestTrade.action} ${analytics.bestTrade.symbol}`,
            fmt`💣 ${FormattedString.b("Worst")}  ${FormattedString.b(signedUsd(analytics.worstTrade.pnl))}   ${analytics.worstTrade.action} ${analytics.worstTrade.symbol}`,
          ],
          "\n",
        ),
      );
    }

    // ── Per-market breakdown ───────────────────────────────────────────────────
    if (analytics.perMarket.length > 0) {
      const top = analytics.perMarket.slice(0, 5);
      const rest = analytics.perMarket.length - top.length;
      const mktLines: FormattedString[] = [fmt`📊 ${FormattedString.b("Per-market P&L")}`];
      for (const m of top) {
        const mWinPct = m.closes > 0 ? Math.round((m.wins / m.closes) * 100) : 0;
        mktLines.push(
          fmt`${FormattedString.b(m.symbol.padEnd(6))}  ${FormattedString.b(signedUsd(m.realizedPnl))}  ·  ${m.fills} fills  ·  ${mWinPct}% win`,
        );
      }
      if (rest > 0) mktLines.push(fmt`${FormattedString.i(`+ ${rest} more`)}`);
      sections.push(FormattedString.join(mktLines, "\n"));
    }
  }

  const msg = FormattedString.join(sections, "\n\n");

  const kb = isOwn
    ? new InlineKeyboard()
        .text("📥 Deposit", "nav:deposit")
        .text("📤 Withdraw", "nav:withdraw")
        .row()
        .text("📋 History", "nav:history")
        .row()
        .text("🖼 Generate Card", `wc:gen:${walletAddress}`)
    : await (async () => {
        const k = new InlineKeyboard();
        const alreadyFollowing = ctx.user
          ? await db.query.walletMonitors.findFirst({
              where: and(
                eq(walletMonitors.userId, ctx.user.id),
                eq(walletMonitors.watchedWallet, walletAddress),
                eq(walletMonitors.enabled, true),
              ),
            })
          : null;
        if (alreadyFollowing) {
          k.text("✅ Following", `walletinfo:unfollow:${walletAddress}`).row();
        } else {
          k.text("👁 Follow this trader", `walletinfo:follow:${walletAddress}`).row();
        }
        const actionRow: [string, string][] = [
          ["📋 Trade History", `walletinfo:histopen:${walletAddress}`],
        ];
        if (validPositions.length > 5) {
          actionRow.push(["📊 All Positions", `walletinfo:posopen:${walletAddress}`]);
        }
        for (const [label, data] of actionRow) k.text(label, data);
        k.row();
        k.text("🖼 Generate Card", `wc:gen:${walletAddress}`);
        return k;
      })();

  await ctx.api.editMessageText(chatId, loadingMsgId, msg.text, {
    entities: msg.entities,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

async function sendWalletPositions(
  ctx: BotContext,
  address: string,
  page: number,
  edit: boolean,
): Promise<void> {
  const state = await getCachedState(address);
  const positions = (state.positions ?? []).filter(
    (p) => Number(p.entryPrice) > 0 && Number(p.markPrice) > 0,
  );

  if (positions.length === 0) {
    const text = `No open positions for ${shortAddr(address)}.`;
    if (edit && ctx.callbackQuery) await ctx.editMessageText(text);
    else await ctx.reply(text);
    return;
  }

  const { items, page: safePage, totalPages } = paginate(positions, page, POS_PAGE_SIZE);
  const botUsername = ctx.me.username ?? "bot";
  const totalUpnl = positions.reduce((s, p) => s + Number(p.unrealizedPnl), 0);
  const pageLabel =
    totalPages > 1 ? fmt`  ·  ${FormattedString.i(`Page ${safePage + 1}/${totalPages}`)}` : fmt``;
  const header = fmt`📊 ${FormattedString.b(`Open Positions (${positions.length})`)} · ${FormattedString.code(shortAddr(address))}${pageLabel}\nTotal uPnL: ${FormattedString.b(signedUsd(totalUpnl))} ${pnlEmoji(totalUpnl)}`;
  const rows = items.map((pos) => buildExternalPositionRow(pos, botUsername));
  const msg = FormattedString.join([header, ...rows], "\n\n");

  const kb = new InlineKeyboard();
  addPaginationRow(kb, `walletinfo:pos:${address}`, safePage, totalPages);
  kb.text("← Trader", `walletinfo:back:${address}`);

  const opts = {
    entities: msg.entities,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  };
  if (edit && ctx.callbackQuery) await ctx.editMessageText(msg.text, opts);
  else await ctx.reply(msg.text, opts);
}

export function registerWallet(bot: Bot<BotContext>) {
  bot.command("wallet", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }

    const arg = ctx.match?.trim();
    if (!arg || !BASE58_RE.test(arg)) {
      const msg = fmt`Send a Solana wallet address to look up:\n${FormattedString.code("/wallet <address>")}`;
      await ctx.reply(msg.text, { entities: msg.entities });
      return;
    }

    const loading = await ctx.reply("Fetching wallet analytics…");
    const chatId = loading.chat.id;
    try {
      await sendWalletScreen(ctx, arg, chatId, loading.message_id);
    } catch {
      await ctx.api.editMessageText(
        chatId,
        loading.message_id,
        "Failed to fetch wallet data. Try again.",
      );
    }
  });

  bot.callbackQuery(/^walletinfo:histopen:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendHistoryScreen(ctx, 0, false, ctx.match[1]);
  });

  bot.callbackQuery(/^walletinfo:hist:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendHistoryScreen(ctx, Number(ctx.match[2]), true, ctx.match[1]);
  });

  bot.callbackQuery(/^walletinfo:back:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Loading…");
    if (!ctx.user) return;
    const address = ctx.match[1];
    const loading = await ctx.reply("Fetching trader info…");
    try {
      await sendWalletScreen(ctx, address, loading.chat.id, loading.message_id);
    } catch {
      await ctx.api.editMessageText(
        loading.chat.id,
        loading.message_id,
        "Failed to fetch trader data. Try again.",
      );
    }
  });

  bot.callbackQuery(/^walletinfo:follow:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery();
      return;
    }
    const address = ctx.match[1];

    if (address === ctx.user.walletAddress) {
      await ctx.answerCallbackQuery({ text: "That's your own wallet.", show_alert: true });
      return;
    }

    const existing = await db
      .select({ id: walletMonitors.id, watchedWallet: walletMonitors.watchedWallet })
      .from(walletMonitors)
      .where(and(eq(walletMonitors.userId, ctx.user.id), eq(walletMonitors.enabled, true)));

    const alreadyFollowing = existing.some((r) => r.watchedWallet === address);
    if (!alreadyFollowing && existing.length >= 10) {
      await ctx.answerCallbackQuery({
        text: "Max 10 monitors. Remove one first via /monitor.",
        show_alert: true,
      });
      return;
    }

    await db
      .insert(walletMonitors)
      .values({
        id: crypto.randomUUID(),
        userId: ctx.user.id,
        watchedWallet: address,
        alertOnFill: true,
        alertOnPositionChange: true,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: [walletMonitors.userId, walletMonitors.watchedWallet],
        set: { enabled: true },
      });

    await redis.publish(
      MONITOR_EVENTS_CHANNEL,
      JSON.stringify({ action: "subscribe", wallet: address, telegramId: ctx.user.telegramId }),
    );

    await ctx.answerCallbackQuery({ text: "✅ Now following this trader", show_alert: false });
    const loading = await ctx.reply("Refreshing…");
    try {
      await sendWalletScreen(ctx, address, loading.chat.id, loading.message_id);
    } catch {
      await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
    }
  });

  bot.callbackQuery(/^walletinfo:unfollow:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery();
      return;
    }
    const address = ctx.match[1];

    await db
      .update(walletMonitors)
      .set({ enabled: false })
      .where(
        and(eq(walletMonitors.userId, ctx.user.id), eq(walletMonitors.watchedWallet, address)),
      );

    await redis.publish(
      MONITOR_EVENTS_CHANNEL,
      JSON.stringify({ action: "unsubscribe", wallet: address, telegramId: ctx.user.telegramId }),
    );

    await ctx.answerCallbackQuery({ text: "Unfollowed", show_alert: false });
    const loading = await ctx.reply("Refreshing…");
    try {
      await sendWalletScreen(ctx, address, loading.chat.id, loading.message_id);
    } catch {
      await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
    }
  });

  bot.callbackQuery(/^walletinfo:posopen:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendWalletPositions(ctx, ctx.match[1], 0, false);
  });

  bot.callbackQuery(/^walletinfo:pos:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendWalletPositions(ctx, ctx.match[1], Number(ctx.match[2]), true);
  });

  bot.callbackQuery(/^wc:gen:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Generating card…");
    const walletAddress = ctx.match[1];

    try {
      const analytics = await getCachedAnalytics(walletAddress);

      const winRate =
        analytics.closedTrades > 0 ? (analytics.wins / analytics.closedTrades) * 100 : null;

      const card = await generateWalletCard({
        walletAddress,
        realizedPnl: analytics.realizedPnl,
        winRate,
        totalFills: analytics.totalFills,
        totalVolume: analytics.totalVolume,
        bestTrade: analytics.bestTrade
          ? { pnl: analytics.bestTrade.pnl, symbol: analytics.bestTrade.symbol }
          : null,
        worstTrade: analytics.worstTrade
          ? {
              pnl: analytics.worstTrade.pnl,
              symbol: analytics.worstTrade.symbol,
            }
          : null,
        referral: referralBadgeData(ctx),
      });

      await ctx.replyWithPhoto(
        new InputFile(card, `wallet-${walletAddress}.png`),
        // {
        //   caption: `📊 ${shortAddr(walletAddress)} · ${analytics.totalFills} fills · ${signedUsd(analytics.realizedPnl)} realized`,
        // }
      );
    } catch (err) {
      console.error("[wc:gen] card generation failed:", err);
      await ctx.reply("Failed to generate card. Try again.");
    }
  });
}
