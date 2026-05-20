import type { Bot, CallbackQueryContext } from "grammy";
import { InlineKeyboard } from "grammy";
import { ISOLATED_ONLY_MARKETS, getMarkets } from "../../services/phoenix/market.js";
import type { BotContext } from "../../types/index.js";

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
) {
  const data = await getMarkets();
  const markets: Record<string, unknown>[] = Array.isArray(data) ? data : (data.markets ?? []);

  const query = "markets" in ctx && typeof (ctx as BotContext & { match?: string }).match === "string"
    ? ""
    : "";

  const start = page * PAGE_SIZE;
  const slice = markets.slice(start, start + PAGE_SIZE);
  const totalPages = Math.ceil(markets.length / PAGE_SIZE);

  const lines = slice.map((m) => {
    const symbol = String(m.symbol ?? m.name ?? "?");
    const isIsolated = ISOLATED_ONLY_MARKETS.has(symbol);
    const badge = isIsolated ? " [ISO]" : "";
    return `• <b>${symbol}${badge}</b> $${m.markPrice ?? "—"} | ${m.fundingRate ?? "—"}% apr`;
  });

  const kb = new InlineKeyboard();
  if (page > 0) kb.text("◀ Prev", `markets:page:${page - 1}`);
  if (page < totalPages - 1) kb.text("Next ▶", `markets:page:${page + 1}`);

  const text = [
    `📊 <b>Markets</b> (${page + 1}/${totalPages})`,
    `<i>[ISO] = Isolated margin only</i>`,
    ``,
    ...lines,
  ].join("\n");

  if (edit && "editMessageText" in ctx) {
    await (ctx as CallbackQueryContext<BotContext>).editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}
