import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import type { BotContext } from "../../types/index.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { shortAddr, usd } from "../lib/fmt.js";

const solConnection = new Connection(config.HELIUS_RPC_URL, "confirmed");

const riskEmoji: Record<string, string> = {
  safe: "🟢",
  healthy: "🟡",
  atRisk: "🟠",
  at_risk: "🟠",
  cancellable: "🔴",
  liquidatable: "🔴",
  backstopLiquidatable: "🔴",
  highRisk: "🔴",
};

const riskLabel: Record<string, string> = {
  safe: "Safe",
  healthy: "Healthy",
  atRisk: "At risk",
  at_risk: "At risk",
  cancellable: "Orders may cancel",
  liquidatable: "⚠️ Near liquidation",
  backstopLiquidatable: "⚠️ Critical",
  highRisk: "⚠️ High risk",
};

export function registerBalance(bot: Bot<BotContext>) {
  bot.command("balance", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("You need an account first. Type /start to get set up.");
      return;
    }
    await sendBalanceScreen(ctx);
  });
}

export async function sendBalanceScreen(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const [state, solLamports] = await Promise.all([
    getTraderState(ctx.user.walletAddress),
    solConnection.getBalance(new PublicKey(ctx.user.walletAddress)).catch(() => 0),
  ]);

  const sol = (solLamports / 1e9).toFixed(4);
  const deposited = Number(state.depositedCollateral);
  const effective = Number(state.effectiveCollateral);
  const upnl = Number(state.unrealizedPnl);
  const funding = Number(state.unsettledFunding);
  const totalValue = effective + upnl + funding;

  const tier = String(state.riskTier ?? "safe");
  const tierLine = `${riskEmoji[tier] ?? "⚪"} ${riskLabel[tier] ?? tier}`;

  const kb = new InlineKeyboard()
    .text("📥 Deposit", "nav:deposit")
    .text("📤 Withdraw", "nav:withdraw")
    .row()
    .text("📊 Positions", "nav:positions")
    .text("📋 History", "nav:history");

  const msg = fmt`💰 ${FormattedString.b("Your Account")}\n\nDeposited         ${FormattedString.b(usd(deposited))}\nAvailable margin  ${FormattedString.b(usd(effective))}\n\nUnrealized P&L    ${FormattedString.b(usd(upnl))}\nPending funding   ${FormattedString.b(usd(funding))}\n\nTotal value       ${FormattedString.b(usd(totalValue))}\n\nGas (SOL)  ${FormattedString.b(`${sol} SOL`)}\nWallet     ${FormattedString.code(shortAddr(ctx.user.walletAddress))}\n\n${tierLine}`;

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
