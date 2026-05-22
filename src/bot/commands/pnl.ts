import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import { getTraderState } from "../../services/phoenix/position.js";
import { usd } from "../lib/fmt.js";
import type { BotContext } from "../../types/index.js";

export function registerPnl(bot: Bot<BotContext>) {
  bot.command("pnl", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }

    const state = await getTraderState(ctx.user.walletAddress);
    const upnl = (state.positions ?? []).reduce(
      (sum, pos) => sum + Number(pos.unrealizedPnl ?? 0),
      0,
    );
    const funding = Number(state.unsettledFunding ?? 0);
    const combined = upnl + funding;

    const kb = new InlineKeyboard()
      .text("📊 Positions", "nav:positions")
      .text("📋 History", "nav:history");

    const msg = fmt`📈 ${FormattedString.b("P&L Summary")}\n\nUnrealized P&L   ${FormattedString.code(usd(upnl))}\nPending funding  ${FormattedString.code(usd(funding))}\n\nCombined         ${FormattedString.code(usd(combined))}\n\n${FormattedString.i("Realized P&L — use /history for per-trade breakdown.")}`;

    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });
}
