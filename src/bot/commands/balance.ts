import type { Bot } from "grammy";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../config/index.js";
import { getTraderState } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";

export function registerBalance(bot: Bot<BotContext>) {
  bot.command("balance", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Use /start to create your account first.");
      return;
    }

    const [state, solLamports] = await Promise.all([
      getTraderState(ctx.user.walletAddress),
      new Connection(config.HELIUS_RPC_URL, "confirmed")
        .getBalance(new PublicKey(ctx.user.walletAddress))
        .catch(() => 0),
    ]);

    const solBalance = (solLamports / 1e9).toFixed(4);

    await ctx.reply(
      [
        `💰 <b>Account Balance</b>`,
        ``,
        `Deposited USDC: <code>${state.depositedCollateral ?? "0.00"}</code>`,
        `Effective collateral: <code>${state.effectiveCollateral ?? "0.00"}</code>`,
        `Unrealized PnL: <code>${state.unrealizedPnl ?? "0.00"}</code>`,
        `Unsettled funding: <code>${state.unsettledFunding ?? "0.00"}</code>`,
        ``,
        `Wallet SOL (gas): <code>${solBalance} SOL</code>`,
        ``,
        `Risk tier: <b>${state.riskTier ?? "Safe"}</b>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });
}
