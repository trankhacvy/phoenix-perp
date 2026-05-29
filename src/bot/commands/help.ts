import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/index.js";

const HEADER = fmt`🔥 ${FormattedString.b("SuperNova")}

Trade perpetual futures on ${FormattedString.link("Phoenix", "https://www.phoenix.trade")} — directly from Telegram.
Long, short, set TP/SL, track P&L, follow top traders.

${FormattedString.i("⚠️ Beta — trade at your own risk.")}

What can I help with?`;

const BASE_CATEGORIES: { key: string; label: string; content: FormattedString }[] = [
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
    key: "protection",
    label: "🛡 Protection",
    content: fmt`🛡 ${FormattedString.b("Protection & Alerts")}

/guardian — Risk rules & auto-protection
/alerts — Price & account alerts
/monitor — Follow traders & get live alerts`,
  },
];

const _REFERRAL_CATEGORY = {
  key: "referral",
  label: "👥 Referral",
  content: fmt`👥 ${FormattedString.b("Referral")}

/referral — Your referral link & stats
/claim — Withdraw referral rebate`,
};

const FAQ_CATEGORY = {
  key: "faq",
  label: "❓ FAQ",
  content: fmt`❓ ${FormattedString.b("FAQ")}

${FormattedString.b("What is SuperNova?")}
SuperNova is a Telegram bot for trading perpetual futures on ${FormattedString.link("Phoenix", "https://www.phoenix.trade")} — a Solana-based DEX. Long, short, set TP/SL, track P&L, follow top traders. All self-custodial, no sign-up, no KYC.

${FormattedString.b("Is my wallet secure?")}
Yes. Wallets are powered by ${FormattedString.link("Privy", "https://www.privy.io")} — a trusted self-custodial wallet infrastructure. Only you control your funds. SuperNova will ${FormattedString.b("never")} ask for your seed phrase or private key. Admins never DM first or request funds. Only use the official bot — never search for bots in Telegram.

${FormattedString.b("What are the fees?")}
SuperNova charges a ${FormattedString.b("0.05% builder fee")} on each trade (taker only). Phoenix protocol adds ~0.06% taker fee. No subscription, no hidden charges.

${FormattedString.b("Common trade failures")}
  · ${FormattedString.i("Slippage exceeded")} — price moved too fast, tap Retry
  · ${FormattedString.i("Not enough SOL for fees")} — send ≥ 0.01 SOL to your bot wallet
  · ${FormattedString.i("Transaction expired")} — safe to retry, blockhash stale
  · ${FormattedString.i("Insufficient margin")} — deposit more USDC via /deposit

${FormattedString.b("My P&L looks wrong?")}
Unrealized P&L is based on the current mark price and excludes fees. Realized P&L in /history includes all trading fees.`,
};

function getCategories() {
  return [...BASE_CATEGORIES, FAQ_CATEGORY];
}

function mainKeyboard(): InlineKeyboard {
  const cats = getCategories();
  const kb = new InlineKeyboard();
  for (let i = 0; i < cats.length; i++) {
    kb.text(cats[i].label, `help:${cats[i].key}`);
    if (i % 2 === 1 && i < cats.length - 1) kb.row();
  }
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

  bot.callbackQuery("help:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(HEADER.text, {
      entities: HEADER.entities,
      reply_markup: mainKeyboard(),
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery(/^help:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = ctx.match[1];
    const cat = getCategories().find((c) => c.key === key);
    if (!cat) return;

    const kb = new InlineKeyboard().text("← Back", "help:back");
    await ctx.editMessageText(cat.content.text, {
      entities: cat.content.entities,
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
  });
}
