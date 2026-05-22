import type { Bot } from "grammy";
import type { BotContext } from "../../types/index.js";
import { clearPending } from "../lib/pending.js";
import { registerAlerts, sendAlertsScreen } from "./alerts.js";
import { registerBalance, sendBalanceScreen } from "./balance.js";
import { registerClaim } from "./claim.js";
import { registerDeposit, sendDepositScreen } from "./deposit.js";
import { registerExport } from "./export.js";
import { registerFunding } from "./funding.js";
import { registerHistory, sendHistoryScreen } from "./history.js";
import { registerLong, sendSymbolPicker } from "./long.js";
import { registerMarkets } from "./markets.js";
import { registerPnl } from "./pnl.js";
import { registerPortfolio } from "./portfolio.js";
import { registerPositions, sendPositionsScreen } from "./positions.js";
import { registerPrice } from "./price.js";
import { registerPriceAlert } from "./pricealert.js";
import { registerReferral } from "./referral.js";
import { registerSetSl } from "./setsl.js";
import { registerSettings } from "./settings.js";
import { registerSetTp } from "./settp.js";
import { registerShare } from "./share.js";
import { registerShort } from "./short.js";
import { registerStart } from "./start.js";
import { registerWithdraw, sendWithdrawAmountPrompt } from "./withdraw.js";

export function registerCommands(bot: Bot<BotContext>) {
  registerStart(bot);
  registerBalance(bot);
  registerDeposit(bot);
  registerWithdraw(bot);
  registerMarkets(bot);
  registerPrice(bot);
  registerLong(bot);
  registerShort(bot);
  registerPositions(bot);
  registerHistory(bot);
  registerPnl(bot);
  registerAlerts(bot);
  registerSettings(bot);
  registerReferral(bot);
  registerShare(bot);
  registerFunding(bot);
  registerPortfolio(bot);
  registerSetSl(bot);
  registerSetTp(bot);
  registerExport(bot);
  registerClaim(bot);
  registerPriceAlert(bot);

  bot.callbackQuery("nav:balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendBalanceScreen(ctx);
  });

  bot.callbackQuery("nav:deposit", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendDepositScreen(ctx);
  });

  bot.callbackQuery("nav:withdraw", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendWithdrawAmountPrompt(ctx);
  });

  bot.callbackQuery("nav:positions", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendPositionsScreen(ctx);
  });

  bot.callbackQuery("nav:history", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendHistoryScreen(ctx);
  });

  bot.callbackQuery("nav:long", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendSymbolPicker(ctx, "long");
  });

  bot.callbackQuery("nav:short", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendSymbolPicker(ctx, "short");
  });

  bot.callbackQuery("nav:alerts", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendAlertsScreen(ctx);
  });

  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    if (ctx.from) await clearPending(ctx.from.id);
    await ctx.editMessageText("Cancelled.");
  });
}
