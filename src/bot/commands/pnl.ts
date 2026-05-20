import type { Bot } from "grammy";
import { getTraderState } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";

export function registerPnl(bot: Bot<BotContext>) {
  bot.command("pnl", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const state = await getTraderState(ctx.user.walletAddress);

    await ctx.reply(
      [
        `📊 <b>PnL Summary</b>`,
        ``,
        `Unrealized: <code>${state.unrealizedPnl ?? "0.00"} USDC</code>`,
        `Unsettled funding: <code>${state.unsettledFunding ?? "0.00"} USDC</code>`,
        ``,
        `<i>Historical realized PnL — use /history for per-trade breakdown.</i>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });
}
