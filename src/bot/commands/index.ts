import type { Bot } from "grammy";
import type { BotContext } from "../../types/index.js";
import { registerAlerts } from "./alerts.js";
import { registerBalance } from "./balance.js";
import { registerClaim } from "./claim.js";
import { registerDeposit } from "./deposit.js";
import { registerExport } from "./export.js";
import { registerFunding } from "./funding.js";
import { registerHistory } from "./history.js";
import { registerLong } from "./long.js";
import { registerMarkets } from "./markets.js";
import { registerPnl } from "./pnl.js";
import { registerPositions } from "./positions.js";
import { registerPrice } from "./price.js";
import { registerPriceAlert } from "./pricealert.js";
import { registerReferral } from "./referral.js";
import { registerSetSl } from "./setsl.js";
import { registerSetTp } from "./settp.js";
import { registerSettings } from "./settings.js";
import { registerShare } from "./share.js";
import { registerShort } from "./short.js";
import { registerStart } from "./start.js";
import { registerWithdraw } from "./withdraw.js";

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
  registerSetSl(bot);
  registerSetTp(bot);
  registerExport(bot);
  registerClaim(bot);
  registerPriceAlert(bot);

  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("Cancelled.");
  });
}
