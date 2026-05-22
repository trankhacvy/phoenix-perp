import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { getTradeHistory } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";
import { cryptoSize, price as fmtPrice, usd } from "../lib/fmt.js";

// ReduceOnly = closing a position; side = fill direction (long=bought, short=sold)
function tradeAction(instructionType: string, side: "long" | "short"): string {
  if (instructionType === "ReduceOnly") {
    return side === "short" ? "Close Long" : "Close Short";
  }
  return side === "long" ? "Open Long" : "Open Short";
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

export async function sendHistoryScreen(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const history = await getTradeHistory(ctx.user.walletAddress, 20);
  const trades = history.trades;

  if (trades.length === 0) {
    await ctx.reply("No trades yet.");
    return;
  }

  const entries = trades.map((t) => {
    const isClose = t.instructionType === "ReduceOnly";
    const action = tradeAction(t.instructionType, t.side);
    const emoji = t.side === "long" ? "🟢" : "🔴";
    const size = cryptoSize(Number(t.size), t.symbol);
    const time = formatTs(t.timestamp);

    const pnl = Number(t.realizedPnl);
    const pnlStr = pnl >= 0 ? `+${usd(pnl)}` : usd(pnl);
    const pnlPart = isClose ? fmt`  ·  P&L: ${FormattedString.code(pnlStr)}` : fmt``;

    return fmt`${emoji} ${FormattedString.b(action)}  ${t.symbol}  ${size}  @${fmtPrice(Number(t.price))}\n${FormattedString.i(time)}${pnlPart}`;
  });

  const footer = history.hasMore
    ? FormattedString.i("Showing 20 most recent.")
    : FormattedString.i(`${trades.length} trade${trades.length === 1 ? "" : "s"} total.`);

  const kb = new InlineKeyboard()
    .text("📊 Positions", "nav:positions")
    .text("💰 Balance", "nav:balance");

  const msg = FormattedString.join(
    [fmt`📋 ${FormattedString.b("Trade History")}`, fmt``, ...entries, footer],
    "\n\n",
  );

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export function registerHistory(bot: Bot<BotContext>) {
  bot.command("history", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    await sendHistoryScreen(ctx);
  });
}
