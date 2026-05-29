import type { Bot } from "grammy";
import type { BotContext } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";
import { clearPending } from "../lib/pending.js";
import { registerActivate } from "./activate.js";
import { registerAlerts, sendAlertsScreen } from "./alerts.js";
import { registerClaim } from "./claim.js";
import { registerDeposit, sendDepositScreen } from "./deposit.js";
import { registerGuardian } from "./guardian.js";
import { registerHelp } from "./help.js";
import { registerHistory, sendHistoryScreen } from "./history.js";
import { registerLeaderboard } from "./leaderboard.js";
import { registerLog } from "./log.js";
import { registerLong, sendSymbolPicker } from "./long.js";
import { registerMarkets, sendMarketsScreen } from "./markets.js";
import { registerPortfolio, sendPortfolioScreen } from "./portfolio.js";
import { registerPositions, sendPositionsScreen } from "./positions.js";
import { registerPriceAlert } from "./pricealert.js";
import { registerReferral } from "./referral.js";
import { registerSettings } from "./settings.js";
import { registerShare } from "./share.js";
import { registerShort } from "./short.js";
import { registerStart } from "./start.js";
import { registerStatus } from "./status.js";
import { registerTpSl } from "./tpsl.js";
import { registerWalletMonitor } from "./wallet-monitor.js";
import { registerWallet } from "./wallet.js";
import { clearWithdrawExtState, registerWithdraw, sendWithdrawAmountPrompt } from "./withdraw.js";

export function registerCommands(bot: Bot<BotContext>) {
  registerStart(bot);
  registerHelp(bot);
  registerActivate(bot);
  registerDeposit(bot);
  registerWithdraw(bot);
  registerMarkets(bot);
  registerLong(bot);
  registerShort(bot);
  registerPositions(bot);
  registerHistory(bot);
  registerAlerts(bot);
  registerSettings(bot);
  registerReferral(bot);
  registerShare(bot);
  registerPortfolio(bot);
  registerTpSl(bot);
  registerClaim(bot);
  registerPriceAlert(bot);
  registerWalletMonitor(bot);
  registerWallet(bot);
  registerLeaderboard(bot);
  registerLog(bot);
  registerStatus(bot);
  registerGuardian(bot);

  bot.callbackQuery("nav:balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendPortfolioScreen(ctx);
  });

  bot.callbackQuery("nav:deposit", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendDepositScreen(ctx);
  });

  bot.callbackQuery("nav:withdraw", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendWithdrawAmountPrompt(ctx);
  });

  bot.callbackQuery("nav:positions", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendPositionsScreen(ctx);
  });

  bot.callbackQuery("nav:history", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendHistoryScreen(ctx);
  });

  bot.callbackQuery("nav:long", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendSymbolPicker(ctx, "long");
  });

  bot.callbackQuery("nav:short", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    if (!(await requireActivation(ctx))) return;
    await sendSymbolPicker(ctx, "short");
  });

  bot.callbackQuery("nav:alerts", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendAlertsScreen(ctx, true);
  });

  bot.callbackQuery("nav:markets", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendMarketsScreen(ctx);
  });

  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    if (ctx.from) {
      await clearPending(ctx.from.id);
      await clearWithdrawExtState(String(ctx.from.id));
    }
    await ctx.editMessageText("Cancelled.");
  });
}
