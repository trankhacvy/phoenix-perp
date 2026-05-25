import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { type Bot, InlineKeyboard, InputFile } from "grammy";
import QRCode from "qrcode";
import { logger } from "../../lib/logger.js";
import { depositCollateral } from "../../services/phoenix/trade.js";
import { getWalletUsdcBalance } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { toBotError } from "../lib/errors.js";
import { parseAmount, solscanUrl, usd } from "../lib/fmt.js";
import { claimIdempotencyKey } from "../lib/idempotent.js";
import { clearPending, setPending } from "../lib/pending.js";

const MIN_DEPOSIT_USD = 1;

export function registerDeposit(bot: Bot<BotContext>) {
  bot.command("deposit", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }
    await sendDepositScreen(ctx);
  });

  // User finished sending USDC to wallet → go to step 2 (fund trading account)
  bot.callbackQuery("deposit:fund", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendFundCollateralScreen(ctx);
  });

  // User wants to retry checking wallet balance
  bot.callbackQuery("deposit:check", async (ctx) => {
    await ctx.answerCallbackQuery("Checking…");
    if (!ctx.user) return;
    await sendFundCollateralScreen(ctx);
  });

  // User picked "All" — deposit everything in wallet
  bot.callbackQuery(/^deposit:all$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const balance = await getWalletUsdcBalance(ctx.user.walletAddress);
    if (balance < MIN_DEPOSIT_USD) {
      await ctx.reply(
        `No USDC in wallet yet. Send at least ${usd(MIN_DEPOSIT_USD)} and try again.`,
      );
      return;
    }
    await sendDepositConfirm(ctx, balance);
  });

  // Custom amount prompt
  bot.callbackQuery("deposit:custom", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    // Defensive: clear any prior pending flow before claiming this one.
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, "deposit_amount");
    const kb = new InlineKeyboard().text("✕ Cancel", "cancel");
    const msg = fmt`How much USDC to add as collateral? Reply with a number (e.g. ${FormattedString.code("25")}).`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^deposit:confirm:(\d+(?:\.\d{1,2})?)$/, async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery("Submitting…");

    if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id))) return;

    const amount = Number(ctx.match[1]);
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_USD) {
      await ctx.reply(`Invalid amount. Minimum is ${usd(MIN_DEPOSIT_USD)}.`);
      return;
    }

    await ctx.editMessageText("⏳ Adding collateral…");

    const user = ctx.user;
    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !msgId) return;
    const api = ctx.api;

    void (async () => {
      try {
        const amountNative = BigInt(Math.round(amount * 1_000_000));
        const sig = await depositCollateral(user.walletAddress, amountNative);
        const msg = fmt`✅ ${FormattedString.b("Collateral added")}\n\n${FormattedString.b(usd(amount))} is now in your trading account.\n\n${FormattedString.link("View on Solscan →", solscanUrl(sig))}\n\nYou're ready to trade — try /long or /short.`;
        await api.editMessageText(chatId, msgId, msg.text, {
          entities: msg.entities,
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        logger.error({ err }, "Deposit collateral failed");
        const be = toBotError(err);
        const errMsg = fmt`${FormattedString.b("❌ Add collateral failed")}\n\n${be.userMessage}${be.hint ? fmt`\n${FormattedString.i(be.hint)}` : fmt``}${be.retryable ? fmt`\n\n↩️ ${FormattedString.i("Safe to retry.")}` : fmt``}`;
        try {
          await api.editMessageText(chatId, msgId, errMsg.text, {
            entities: errMsg.entities,
          });
        } catch (editErr) {
          logger.warn({ err: editErr }, "failed to edit error message after deposit failure");
        }
      }
    })().catch((err) => logger.error({ err }, "deposit async error"));
  });
}

/**
 * Step 1: show receive address + QR. Always — user explicitly asked for the
 * address. Idle-USDC users can use the "Add Collateral" shortcut from /portfolio.
 */
export async function sendDepositScreen(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const { walletAddress } = ctx.user;

  const qr = await QRCode.toBuffer(walletAddress, { type: "png", width: 256 });
  const kb = new InlineKeyboard()
    .text("✅ I've sent USDC — continue", "deposit:fund")
    .row()
    .text("← Back", "nav:balance");

  const msg = fmt`📥 ${FormattedString.b("Deposit — Step 1 of 2")}

Send ${FormattedString.b("USDC")} to your wallet:
${FormattedString.code(walletAddress)}

${FormattedString.b("How it works")}
${FormattedString.b("1.")} Send USDC here (this screen)
${FormattedString.b("2.")} Tap continue to add it as collateral
${FormattedString.b("3.")} Start trading

Only send standard USDC (${FormattedString.code("EPjF…Dt1v")}).
Keep ${FormattedString.b("≈0.01 SOL")} for gas.`;

  await ctx.replyWithPhoto(new InputFile(qr, "deposit-qr.png"), {
    caption: msg.caption,
    caption_entities: msg.caption_entities,
    reply_markup: kb,
  });
}

/**
 * Step 2: move wallet USDC → Phoenix PDA collateral.
 * Also reachable directly from the "Add Collateral" button in /portfolio.
 */
export async function sendFundCollateralScreen(
  ctx: BotContext,
  cachedBalance?: number,
): Promise<void> {
  if (!ctx.user) return;

  const balance = cachedBalance ?? (await getWalletUsdcBalance(ctx.user.walletAddress));

  if (balance < MIN_DEPOSIT_USD) {
    const kb = new InlineKeyboard()
      .text("🔄 Check again", "deposit:check")
      .row()
      .text("← Back", "nav:balance");
    const msg = fmt`⏳ ${FormattedString.b("Waiting for USDC")}

We don't see any USDC in your wallet yet.

If you just sent it, give it ${FormattedString.b("~30 seconds")} to confirm on-chain, then tap below.`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
    return;
  }

  const kb = new InlineKeyboard()
    .text(`✅ Add all (${usd(balance)})`, "deposit:all")
    .text("✏️ Custom amount", "deposit:custom")
    .row()
    .text("← Later", "nav:balance");

  const msg = fmt`💰 ${FormattedString.b("Add Collateral — Step 2 of 2")}

Wallet balance: ${FormattedString.b(usd(balance))} USDC

Move your USDC into your trading account to start trading. Collateral can be withdrawn back to your wallet anytime.`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

/**
 * Final confirm screen before executing the on-chain deposit.
 */
export async function sendDepositConfirm(ctx: BotContext, amount: number): Promise<void> {
  if (!ctx.user) return;

  // Clamp to 2 decimals (USD precision). Avoids scientific-notation in
  // callback_data and matches what the user sees in the confirm message.
  const clamped = Math.floor(amount * 100) / 100;

  if (clamped < MIN_DEPOSIT_USD) {
    await ctx.reply(`Minimum deposit is ${usd(MIN_DEPOSIT_USD)}.`);
    return;
  }

  const balance = await getWalletUsdcBalance(ctx.user.walletAddress);
  if (clamped > balance + 0.01) {
    await ctx.reply(`You only have ${usd(balance)} USDC in your wallet. Enter a smaller amount.`);
    return;
  }

  const kb = new InlineKeyboard()
    .text(`✅ Add ${usd(clamped)}`, `deposit:confirm:${clamped.toFixed(2)}`)
    .text("✕ Cancel", "cancel");

  const msg = fmt`Add ${FormattedString.b(usd(clamped))} as collateral to your trading account?`;
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

export { parseAmount };
