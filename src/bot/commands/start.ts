import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { fmt, FormattedString } from "@grammyjs/parse-mode";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/index.js";
import { config } from "../../config/index.js";
import { redis } from "../../lib/redis.js";
import { generateReferralCode, linkReferral } from "../../services/referral.js";
import { activatePhoenixAccount, createEmbeddedWallet } from "../../services/wallet.js";
import { sendPositionDetail } from "./positions.js";
import type { BotContext } from "../../types/index.js";

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

      const solLamports = await new Connection(config.HELIUS_RPC_URL, "confirmed")
        .getBalance(new PublicKey(ctx.user.walletAddress))
        .catch(() => 0);
      const sol = (solLamports / 1e9).toFixed(4);
      const kb = new InlineKeyboard()
        .text("💰 Balance", "nav:balance")
        .text("📊 Positions", "nav:positions")
        .row()
        .text("🟢 Long", "nav:long")
        .text("🔴 Short", "nav:short");
      const msg = fmt`👋 ${FormattedString.b("Welcome back!")}\n\n${FormattedString.code(ctx.user.walletAddress)}\nSOL balance: ${FormattedString.b(`${sol} SOL`)}`;
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
            ctx.chat!.id,
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
        const welcome = fmt`🔥 ${FormattedString.b("Welcome to PhoenixPerpBot!")}\n\nYour wallet is ready.\n${FormattedString.code(walletAddress)}\n\nUse /deposit to fund your account, then /markets to start trading.`;
        await ctx.api.editMessageText(ctx.chat!.id, msgId, welcome.text, {
          entities: welcome.entities,
        });
      }
    } catch (err) {
      if (msgId) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
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
