export { sendPriceAlertConfirm } from "./alerts.js";

import type { Bot } from "grammy";
import type { BotContext } from "../../types/index.js";

export function registerPriceAlert(_bot: Bot<BotContext>) {
  // Price alert callbacks are now handled inside registerAlerts().
  // This function is kept for backwards compatibility with the import in commands/index.ts.
}
