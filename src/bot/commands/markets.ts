import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot, CallbackQueryContext } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  ISOLATED_ONLY_MARKETS,
  getMarketSnapshot,
  getMarkets,
} from "../../services/phoenix/market.js";
import type { BotContext } from "../../types/index.js";
import { price as fmtPrice, fundingApr } from "../lib/fmt.js";

const PAGE_SIZE = 10;

export function registerMarkets(bot: Bot<BotContext>) {
  bot.command("markets", async (ctx) => {
    await sendMarketsPage(ctx, 0, false);
  });

  bot.callbackQuery(/^markets:page:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = Number(ctx.match[1]);
    await sendMarketsPage(ctx, page, true);
  });
}

async function sendMarketsPage(
  ctx: BotContext | CallbackQueryContext<BotContext>,
  page: number,
  edit: boolean,
): Promise<void> {
  const allMarkets = await getMarkets();
  const totalPages = Math.ceil(allMarkets.length / PAGE_SIZE);
  const slice = allMarkets.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const snapshots = await Promise.allSettled(slice.map((m) => getMarketSnapshot(m.symbol)));

  const kb = new InlineKeyboard();
  const lines: FormattedString[] = [
    fmt`📊 ${FormattedString.b("Markets")}  (${page + 1} / ${totalPages})`,
    fmt``,
  ];

  slice.forEach((m, i) => {
    const snap = snapshots[i].status === "fulfilled" ? snapshots[i].value : null;
    const isIsolated = ISOLATED_ONLY_MARKETS.has(m.symbol) || m.isolatedOnly;
    const isolatedTag = isIsolated ? fmt` ${FormattedString.i("[ISO]")}` : fmt``;
    const priceStr = snap ? fmtPrice(snap.markPrice) : "—";
    const aprStr = snap ? fundingApr(snap.fundingRate) : "—";

    lines.push(
      fmt`${FormattedString.b(m.symbol)}${isolatedTag}   ${FormattedString.b(priceStr)}   ${FormattedString.i(aprStr)}`,
    );
    kb.text(m.symbol, `price:${m.symbol}`).row();
  });

  const navRow = new InlineKeyboard();
  if (page > 0) navRow.text("◀ Prev", `markets:page:${page - 1}`);
  if (page < totalPages - 1) navRow.text("Next ▶", `markets:page:${page + 1}`);

  const finalKb = new InlineKeyboard();
  for (const row of kb.inline_keyboard) {
    finalKb.add(...row).row();
  }
  for (const row of navRow.inline_keyboard) {
    finalKb.add(...row);
  }

  const msg = FormattedString.join(lines, "\n");

  if (edit && "editMessageText" in ctx) {
    await (ctx as CallbackQueryContext<BotContext>).editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: finalKb,
    });
  } else {
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: finalKb });
  }
}
