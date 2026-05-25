import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { Connection, PublicKey } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/index.js";
import { INVITE_SEARCH_URL } from "../../lib/constants.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { getOrderbook } from "../../services/phoenix/market.js";
import { generateReferralCode, linkReferral } from "../../services/referral.js";
import { createEmbeddedWallet } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { usd } from "../lib/fmt.js";
import { BASE58_RE } from "../lib/validate.js";
import { sendHistoryDetail } from "./history.js";
import { sendSizeStep } from "./long.js";
import { sendMarketDetail } from "./markets.js";
import { sendPositionDetail } from "./positions.js";

const WALLET_CREATE_LIMIT = 10;
const WALLET_CREATE_WINDOW = 60;

export function registerStart(bot: Bot<BotContext>) {
  bot.command("start", async (ctx) => {
    if (!ctx.from) return;

    // ── Existing user ─────────────────────────────────────────────────────────
    if (ctx.user) {
      const payload = ctx.match ? String(ctx.match).trim() : "";

      if (payload.startsWith("pos_")) {
        const parts = payload.slice(4).split("_");
        const symbol = parts[0]?.toUpperCase();
        const side = parts[1] as "long" | "short" | undefined;
        if (symbol && (side === "long" || side === "short")) {
          await sendPositionDetail(ctx, symbol, side);
          return;
        }
      }

      if (payload.startsWith("hist_")) {
        const parts = payload.slice(5).split("_");
        const globalIdx = Number(parts[0]);
        const fromPage = Number(parts[1] ?? "0");
        if (!Number.isNaN(globalIdx)) {
          await sendHistoryDetail(ctx, globalIdx, fromPage);
          return;
        }
      }

      if (payload.startsWith("mkt_")) {
        const parts = payload.slice(4).split("_");
        const symbol = parts[0]?.toUpperCase();
        const fromPage = Number(parts[1] ?? "0");
        if (symbol) {
          await sendMarketDetail(ctx, symbol, Number.isNaN(fromPage) ? 0 : fromPage);
          return;
        }
      }

      if (payload.startsWith("wallet_")) {
        const address = payload.slice(7);
        if (BASE58_RE.test(address)) {
          const loading = await ctx.reply("Fetching wallet analytics…");
          try {
            const { sendWalletScreen } = await import("./wallet.js");
            await sendWalletScreen(ctx, address, loading.chat.id, loading.message_id);
          } catch (err) {
            logger.error({ err, walletAddress: address }, "wallet deep link failed");
            await ctx.api.editMessageText(
              loading.chat.id,
              loading.message_id,
              "Failed to fetch wallet data. Try again.",
            );
          }
          return;
        }
      }

      if (payload.startsWith("long_") || payload.startsWith("short_")) {
        const side = payload.startsWith("long_") ? "long" : "short";
        const rest = payload.slice(side.length + 1);
        const symbol = rest.replace(/_\d+$/, "").toUpperCase();
        if (symbol) {
          if (!ctx.user.phoenixActivated) {
            const kb = new InlineKeyboard().text("Activate account", "nav:activate");
            await ctx.reply(
              "Your trading account isn't activated yet.\nUse /activate <code> to unlock trading.",
              { reply_markup: kb },
            );
            return;
          }
          await sendSizeStep(ctx, side, symbol);
          return;
        }
      }

      const name = ctx.from.first_name ?? "trader";

      if (!ctx.user.phoenixActivated) {
        const kb = new InlineKeyboard()
          .text("🔑 Enter invite code", "nav:activate")
          .row()
          .url("Find an invite code on X →", INVITE_SEARCH_URL)
          .row()
          .text("💰 Deposit", "nav:deposit")
          .text("📈 Markets", "nav:markets");
        const msg = fmt`👋 ${FormattedString.b(`Welcome back, ${name}!`)}\n\n🔒 ${FormattedString.b("Account not activated")}\n\nYou need an invite or access code to start trading.\n\nUse /activate <code> — or tap below to find one.\n\n${FormattedString.code(ctx.user.walletAddress)}\n\n${FormattedString.i("⚠️ Beta — trade at your own risk.")}`;
        await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
        return;
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
      const kb = new InlineKeyboard()
        .text("📊 Portfolio", "nav:balance")
        .text("📊 Positions", "nav:positions")
        .row()
        .text("🟢 Long", "nav:long")
        .text("🔴 Short", "nav:short")
        .row()
        .text("📈 Markets", "nav:markets")
        .text("📋 History", "nav:history");
      const msg = fmt`🔥 ${FormattedString.b(`Welcome back, ${name}!`)}\n\n💰 ${FormattedString.b("Wallet Balance")}\n${FormattedString.b(`${sol.toFixed(4)} SOL`)}${solPrice > 0 ? fmt`  (${FormattedString.b(usd(solUsd))})` : fmt``}\n\n${FormattedString.code(ctx.user.walletAddress)}\n\nDeposit USDC to fund your account and start trading.\n\n${FormattedString.i("⚠️ Beta — trade at your own risk.")}`;
      await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
      return;
    }

    // ── New user: create wallet ───────────────────────────────────────────────
    const telegramId = String(ctx.from.id);
    const rawPayload = ctx.match ? String(ctx.match).trim() : "";
    const DEEP_LINK_PREFIXES = ["pos_", "hist_", "mkt_", "wallet_", "long_", "short_"];
    const isDeepLink = DEEP_LINK_PREFIXES.some((p) => rawPayload.startsWith(p));
    const referredBy = rawPayload && !isDeepLink ? rawPayload : undefined;

    const globalKey = "ratelimit:wallet_create:global";
    const count = await redis.incr(globalKey);
    if (count === 1) await redis.expire(globalKey, WALLET_CREATE_WINDOW);
    if (count > WALLET_CREATE_LIMIT) {
      await ctx.reply("Too many new signups right now. Please try again in a minute.");
      return;
    }

    const setupMsg = await ctx.reply("Creating your wallet... ⏳");
    const msgId = setupMsg.message_id;
    const chatId = ctx.chat?.id;

    try {
      const existing = await db.query.users.findFirst({
        where: eq(users.telegramId, telegramId),
      });
      if (existing) {
        await ctx.api.editMessageText(
          chatId,
          msgId,
          "Account already exists. Use /portfolio to check your balance.",
        );
        return;
      }

      const { privyUserId, privyWalletId, walletAddress } = await createEmbeddedWallet(telegramId);
      const referralCode = generateReferralCode();

      await db.insert(users).values({
        id: telegramId,
        telegramId,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        privyUserId,
        privyWalletId,
        walletAddress,
        phoenixActivated: false,
        referralCode,
        referredBy,
      });

      if (referredBy && config.REFERRAL_ENABLED) await linkReferral(telegramId, referredBy);

      const kb = new InlineKeyboard()
        .text("💰 Deposit", "nav:deposit")
        .text("📈 Markets", "nav:markets");

      const msg = fmt`🔥 ${FormattedString.b("Welcome to SuperNova!")}\n\nWe created a Solana wallet for you:\n${FormattedString.code(walletAddress)}\n\nDeposit USDC to fund your account.\n\n⚠️ ${FormattedString.b("Activate trading:")}\nUse /activate <code> with your Phoenix invite or referral code to unlock trading.\n\n${FormattedString.i("⚠️ SuperNova is in beta. Trade at your own risk. Perpetual futures involve significant risk of loss.")}`;

      await ctx.api.editMessageText(chatId, msgId, msg.text, {
        entities: msg.entities,
        reply_markup: kb,
      });
    } catch (err) {
      await ctx.api.editMessageText(chatId, msgId, "❌ Setup failed. Please try again.");
      throw err;
    }
  });
}
