import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { Connection, PublicKey } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/index.js";
import { redis } from "../../lib/redis.js";
import { generateReferralCode, linkReferral } from "../../services/referral.js";
import { getOrderbook } from "../../services/phoenix/market.js";
import { activatePhoenixAccount, createEmbeddedWallet } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { usd } from "../lib/fmt.js";
import { sendHistoryDetail } from "./history.js";
import { sendMarketDetail } from "./markets.js";
import { sendPositionDetail } from "./positions.js";

export function registerStart(bot: Bot<BotContext>) {
  bot.command("start", async (ctx) => {
    if (!ctx.from) return;

    if (ctx.user) {
      const payload = ctx.match ? String(ctx.match).trim() : "";

      // Deep link from position list: ?start=pos_BTC_long
      if (payload.startsWith("pos_")) {
        const parts = payload.slice(4).split("_");
        const symbol = parts[0]?.toUpperCase();
        const side = parts[1] as "long" | "short" | undefined;
        if (symbol && (side === "long" || side === "short")) {
          await sendPositionDetail(ctx, symbol, side);
          return;
        }
      }

      // Deep link from history list: ?start=hist_<globalIdx>_<page>
      if (payload.startsWith("hist_")) {
        const parts = payload.slice(5).split("_");
        const globalIdx = Number(parts[0]);
        const fromPage = Number(parts[1] ?? "0");
        if (!Number.isNaN(globalIdx)) {
          await sendHistoryDetail(ctx, globalIdx, fromPage);
          return;
        }
      }

      // Deep link from markets list: ?start=mkt_<symbol>_<page>
      if (payload.startsWith("mkt_")) {
        const parts = payload.slice(4).split("_");
        const symbol = parts[0]?.toUpperCase();
        const fromPage = Number(parts[1] ?? "0");
        if (symbol) {
          await sendMarketDetail(ctx, symbol, Number.isNaN(fromPage) ? 0 : fromPage);
          return;
        }
      }

      const [solLamports, solBook] = await Promise.all([
        new Connection(config.HELIUS_RPC_URL, "confirmed")
          .getBalance(new PublicKey(ctx.user.walletAddress))
          .catch(() => 0),
        getOrderbook("SOL").catch(() => null),
      ]);
      const sol = solLamports / 1e9;
      const solPrice = solBook?.mid ?? 0;
      const solUsd = sol * solPrice;
      const name = ctx.from.first_name ?? "trader";
      const kb = new InlineKeyboard()
        .text("📊 Portfolio", "nav:balance")
        .text("📊 Positions", "nav:positions")
        .row()
        .text("🟢 Long", "nav:long")
        .text("🔴 Short", "nav:short")
        .row()
        .text("📈 Markets", "nav:markets")
        .text("📋 History", "nav:history");
      const msg = fmt`🔥 ${FormattedString.b(`Welcome back, ${name}!`)}\n\n💰 ${FormattedString.b("Wallet Balance")}\n${FormattedString.b(`${sol.toFixed(4)} SOL`)}${solPrice > 0 ? fmt`  (${FormattedString.b(usd(solUsd))})` : fmt``}\n\n${FormattedString.code(ctx.user.walletAddress)}\n\nDeposit USDC to fund your account and start trading.`;
      await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
      return;
    }

    const telegramId = String(ctx.from.id);
    const referredBy = ctx.match ? String(ctx.match).trim() : undefined;

    const kb = new InlineKeyboard()
      .text("✅ I am not a US person", `attest:notus:${referredBy ?? ""}`)
      .row()
      .text("❌ I am a US person", "attest:us");

    await redis.set(`attest:pending:${telegramId}`, "1", "EX", 300);

    const msg = fmt`🔥 ${FormattedString.b("Welcome to PhoenixPerpBot")}\n\nBefore continuing, please confirm your jurisdiction.\nThis service is not available to US persons or residents of sanctioned jurisdictions.`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^attest:notus:(.*)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;

    const telegramId = String(ctx.from.id);
    const pending = await redis.get(`attest:pending:${telegramId}`);
    if (!pending) {
      await ctx.editMessageText("Attestation expired. Please type /start again.");
      return;
    }
    await redis.del(`attest:pending:${telegramId}`);

    const referredBy = ctx.match[1] || undefined;

    const msgResult = await ctx.editMessageText("Setting up your account... ⏳");
    const msgId =
      typeof msgResult === "object" && "message_id" in msgResult ? msgResult.message_id : undefined;

    try {
      const existing = await db.query.users.findFirst({
        where: eq(users.telegramId, telegramId),
      });
      if (existing) {
        if (msgId) {
          await ctx.api.editMessageText(
            ctx.chat?.id ?? 0,
            msgId,
            "Account already exists. Use /balance to check your account.",
          );
        }
        return;
      }

      const { privyUserId, walletAddress } = await createEmbeddedWallet(telegramId);
      await activatePhoenixAccount(walletAddress);

      const referralCode = generateReferralCode();

      await db.insert(users).values({
        id: telegramId,
        telegramId,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        privyUserId,
        walletAddress,
        phoenixActivated: true,
        referralCode,
        referredBy,
      });

      if (referredBy) {
        await linkReferral(telegramId, referredBy);
      }

      if (msgId) {
        const welcome = fmt`🔥 ${FormattedString.b("Welcome to PhoenixPerpBot!")}\n\nYour Phoenix account is ready to trade.\n\n${FormattedString.code(walletAddress)}\n\nDeposit USDC to fund your account, then use /markets to explore all pairs.`;
        await ctx.api.editMessageText(ctx.chat?.id ?? 0, msgId, welcome.text, {
          entities: welcome.entities,
        });
      }
    } catch (err) {
      if (msgId) {
        await ctx.api.editMessageText(
          ctx.chat?.id ?? 0,
          msgId,
          "❌ Setup failed. Please try again or contact support.",
        );
      }
      throw err;
    }
  });

  bot.callbackQuery("attest:us", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    await redis.del(`attest:pending:${String(ctx.from.id)}`);
    await ctx.editMessageText("Service not available in your region. Thank you for your honesty.");
  });
}
