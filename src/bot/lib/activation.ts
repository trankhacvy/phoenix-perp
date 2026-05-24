import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/index.js";

const INVITE_SEARCH_URL = "https://x.com/search?q=%23PhoenixPerp+invite";

export async function requireActivation(ctx: BotContext): Promise<boolean> {
  if (ctx.user?.phoenixActivated) return true;
  const kb = new InlineKeyboard()
    .text("🔑 Enter invite code", "nav:activate")
    .row()
    .url("Find an invite code on X →", INVITE_SEARCH_URL);
  await ctx.reply(
    "🔒 Account not activated.\n\nYou need an invite or access code to use this feature.\n\nAsk a friend for a code, or search for one — then use /activate <code>",
    { reply_markup: kb },
  );
  return false;
}
