import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { type Bot, InputFile } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  computeWalletAnalytics,
  fetchAllTradeHistory,
  getTraderState,
} from "../../services/phoenix/position.js";
import { generateWalletCard } from "../../services/image.js";
import type { BotContext } from "../../types/index.js";
import {
  compactUsd,
  pnlEmoji,
  shortAddr,
  signedUsd,
  timeAgo,
  usd,
} from "../lib/fmt.js";
import { BASE58_RE } from "../lib/validate.js";
import { sendHistoryScreen } from "./history.js";

async function sendWalletScreen(
  ctx: BotContext,
  walletAddress: string,
  chatId: number,
  loadingMsgId: number,
): Promise<void> {
  const isOwn = walletAddress === ctx.user?.walletAddress;

  const [state, allTrades] = await Promise.all([
    getTraderState(walletAddress),
    fetchAllTradeHistory(walletAddress),
  ]);

  const analytics = computeWalletAnalytics(allTrades);
  const collateral = Number(state.effectiveCollateral);

  if (collateral === 0 && analytics.totalFills === 0) {
    await ctx.api.editMessageText(
      chatId,
      loadingMsgId,
      `No Phoenix activity found for ${shortAddr(walletAddress)}.`,
    );
    return;
  }

  const sections: FormattedString[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  sections.push(fmt`📊 ${FormattedString.code(shortAddr(walletAddress))}`);

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

  // ── Performance ──────────────────────────────────────────────────────────────
  if (analytics.totalFills > 0) {
    const winPct =
      analytics.closedTrades > 0
        ? Math.round((analytics.wins / analytics.closedTrades) * 100)
        : null;
    const winStr =
      winPct !== null
        ? `${winPct}%  (${analytics.wins} / ${analytics.closedTrades} closes)`
        : "—";
    const longPct = Math.round(
      (analytics.longCount / analytics.totalFills) * 100,
    );
    const makerPct = Math.round(
      (analytics.makerCount / analytics.totalFills) * 100,
    );
    const lastStr =
      analytics.lastFillAt !== null ? timeAgo(analytics.lastFillAt) : "—";

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
      const mktLines: FormattedString[] = [
        fmt`📊 ${FormattedString.b("Per-market P&L")}`,
      ];
      for (const m of top) {
        const mWinPct =
          m.closes > 0 ? Math.round((m.wins / m.closes) * 100) : 0;
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
    : new InlineKeyboard()
        .text("📋 Trade History", `walletinfo:hist:${walletAddress}:0`)
        .row()
        .text("👁 Monitor", `monitor:add:${walletAddress}`)
        .row()
        .text("🖼 Generate Card", `wc:gen:${walletAddress}`);

  await ctx.api.editMessageText(chatId, loadingMsgId, msg.text, {
    entities: msg.entities,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

export function registerWallet(bot: Bot<BotContext>) {
  bot.command("wallet", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
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

  bot.callbackQuery(
    /^walletinfo:hist:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d+)$/,
    async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.user) return;
      const address = ctx.match[1];
      const page = Number(ctx.match[2]);
      await sendHistoryScreen(ctx, page, true, address);
    },
  );

  bot.callbackQuery(/^wc:gen:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Generating card…");
    const walletAddress = ctx.match[1];

    try {
      const allTrades = await fetchAllTradeHistory(walletAddress);
      const analytics = computeWalletAnalytics(allTrades);

      const winRate =
        analytics.closedTrades > 0
          ? (analytics.wins / analytics.closedTrades) * 100
          : null;

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
