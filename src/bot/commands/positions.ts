import type { Bot } from "grammy";
import { closePosition, setTpSl, addMargin } from "../../services/phoenix/trade.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { positionKeyboard } from "../keyboards/position.js";
import { redis } from "../../lib/redis.js";
import type { BotContext } from "../../types/index.js";

export function registerPositions(bot: Bot<BotContext>) {
  bot.command("positions", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start first.");
      return;
    }

    const state = await getTraderState(ctx.user.walletAddress);
    const positions = state.positions ?? [];

    if (positions.length === 0) {
      await ctx.reply("No open positions.");
      return;
    }

    for (const pos of positions) {
      const pnlSign = Number(pos.unrealizedPnl) >= 0 ? "+" : "";
      await ctx.reply(
        [
          `<b>${pos.symbol} ${pos.side.toUpperCase()}</b> [${pos.marginMode.toUpperCase()}]`,
          ``,
          `Size: <code>${pos.size}</code>`,
          `Entry: <code>$${pos.entryPrice}</code>`,
          `Mark: <code>$${pos.markPrice}</code>`,
          `uPnL: <code>${pnlSign}${pos.unrealizedPnl} USDC</code>`,
          `Liq price: <code>$${pos.liquidationPrice}</code>`,
          ``,
          `<i>Effective collateral uses discounted uPnL — liq price may shift with market moves or funding.</i>`,
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: positionKeyboard(pos.symbol) },
      );
    }
  });

  bot.callbackQuery(/^close:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Closing...");
    if (!ctx.user) return;

    const symbol = ctx.match[1];
    const fraction = Number(ctx.match[2]) / 100;

    try {
      const sig = await closePosition(symbol, ctx.user.walletAddress, fraction);
      await ctx.editMessageText(
        `✅ Closed ${fraction * 100}% of ${symbol}\n\nTx: <code>${sig}</code>`,
        { parse_mode: "HTML" },
      );
    } catch {
      await ctx.editMessageText("❌ Close failed. Please try again.");
    }
  });

  bot.callbackQuery(/^margin:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const symbol = ctx.match[1];
    await ctx.reply(
      `How much USDC to add as margin for <b>${symbol}</b>?\n\nReply with a number (e.g. <code>50</code>).`,
      { parse_mode: "HTML" },
    );
    await redis.set(`pending:${ctx.from.id}`, `addmargin:${symbol}`, "EX", 120);
  });

  bot.callbackQuery(/^editsl:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const symbol = ctx.match[1];
    await ctx.reply(`Enter new Stop-Loss price for <b>${symbol}</b>:`, { parse_mode: "HTML" });
    await redis.set(`pending:${ctx.from.id}`, `editsl:${symbol}`, "EX", 120);
  });

  bot.callbackQuery(/^edittp:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const symbol = ctx.match[1];
    await ctx.reply(`Enter new Take-Profit price for <b>${symbol}</b>:`, { parse_mode: "HTML" });
    await redis.set(`pending:${ctx.from.id}`, `edittp:${symbol}`, "EX", 120);
  });
}
