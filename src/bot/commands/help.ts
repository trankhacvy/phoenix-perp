import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/index.js";

const HEADER = fmt`🔥 ${FormattedString.b("PhoenixPerpBot")}

Trade perpetual futures on ${FormattedString.link("Phoenix", "https://www.phoenix.trade")} — directly from Telegram.
Long, short, set TP/SL, track P&L, follow top traders.

What can I help with?`;

const CATEGORIES: { key: string; label: string; content: FormattedString }[] = [
  {
    key: "account",
    label: "💰 Account",
    content: fmt`💰 ${FormattedString.b("Account")}

/start — Create wallet & get started
/activate — Unlock trading with invite code
/deposit — Add USDC to your account
/withdraw — Move funds out
/portfolio — Full account overview
/settings — Slippage & default leverage`,
  },
  {
    key: "trading",
    label: "📈 Trading",
    content: fmt`📈 ${FormattedString.b("Trading")}

/long — Open a long position
/short — Open a short position
/positions — View & manage open positions
/setsl — Set stop loss
/settp — Set take profit
/markets — Browse all markets
/market <symbol> — Market detail + technicals`,
  },
  {
    key: "history",
    label: "📋 History",
    content: fmt`📋 ${FormattedString.b("History & Analytics")}

/history — Trade history with P&L
/share <symbol> — Generate PnL card image
/wallet <address> — Look up any trader's stats
/leaderboard — Top traders by volume/PnL/win rate`,
  },
  {
    key: "alerts",
    label: "🔔 Alerts",
    content: fmt`🔔 ${FormattedString.b("Alerts & Monitoring")}

/alerts — Toggle alert types on/off
/alert <symbol> — Set price alert
/monitor — Follow traders & get live alerts
/funding — Top funding rates across markets`,
  },
  {
    key: "referral",
    label: "👥 Referral",
    content: fmt`👥 ${FormattedString.b("Referral")}

/referral — Your referral link & stats
/claim — Withdraw referral rebate`,
  },
];

function mainKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(CATEGORIES[0].label, `help:${CATEGORIES[0].key}`)
    .text(CATEGORIES[1].label, `help:${CATEGORIES[1].key}`)
    .row()
    .text(CATEGORIES[2].label, `help:${CATEGORIES[2].key}`)
    .text(CATEGORIES[3].label, `help:${CATEGORIES[3].key}`)
    .row()
    .text(CATEGORIES[4].label, `help:${CATEGORIES[4].key}`);
  return kb;
}

export function registerHelp(bot: Bot<BotContext>) {
  bot.command("help", async (ctx) => {
    await ctx.reply(HEADER.text, {
      entities: HEADER.entities,
      reply_markup: mainKeyboard(),
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery(/^help:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = ctx.match[1];
    const cat = CATEGORIES.find((c) => c.key === key);
    if (!cat) return;

    const kb = new InlineKeyboard().text("← Back", "help:back");
    await ctx.editMessageText(cat.content.text, {
      entities: cat.content.entities,
      reply_markup: kb,
    });
  });

  bot.callbackQuery("help:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(HEADER.text, {
      entities: HEADER.entities,
      reply_markup: mainKeyboard(),
      link_preview_options: { is_disabled: true },
    });
  });
}
