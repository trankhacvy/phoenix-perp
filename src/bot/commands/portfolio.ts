import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import { getTraderState } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";
import { cryptoSize, price as fmtPrice, shortAddr, usd } from "../lib/fmt.js";

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

export function registerPortfolio(bot: Bot<BotContext>) {
  bot.command("portfolio", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    await sendPortfolioScreen(ctx);
  });
}

export async function sendPortfolioScreen(ctx: BotContext): Promise<void> {
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

  const accountSection = fmt`💰 ${FormattedString.b("Account")}\n\nDeposited         ${FormattedString.b(usd(deposited))}\nAvailable margin  ${FormattedString.b(usd(effective))}\nUnrealized P&L    ${FormattedString.b(usd(upnl))}\nPending funding   ${FormattedString.b(usd(funding))}\nTotal value       ${FormattedString.b(usd(totalValue))}\n\nGas (SOL)  ${FormattedString.b(`${sol} SOL`)}\nWallet     ${FormattedString.code(shortAddr(ctx.user.walletAddress))}\n${riskEmoji[tier] ?? "⚪"} ${tier}`;

  let positionsSection = fmt``;
  if (state.positions.length > 0) {
    const posLines = state.positions.map((pos) => {
      const upnlPos = Number(pos.unrealizedPnl);
      const pnlSign = upnlPos >= 0 ? "+" : "";
      const emoji = pos.side === "long" ? "🟢" : "🔴";
      const liqLabel =
        pos.liquidationPrice === "N/A" ? "—" : fmtPrice(Number(pos.liquidationPrice));
      return fmt`${emoji} ${FormattedString.b(pos.symbol)}  ${cryptoSize(Number(pos.size), pos.symbol)}\n   Entry: ${fmtPrice(Number(pos.entryPrice))}  Mark: ${fmtPrice(Number(pos.markPrice))}\n   P&L: ${FormattedString.b(`${pnlSign}${usd(upnlPos)}`)}  Liq: ${liqLabel}`;
    });
    positionsSection = FormattedString.join(
      [fmt`\n\n📊 ${FormattedString.b(`Positions (${state.positions.length})`)}`, ...posLines],
      "\n",
    );
  } else {
    positionsSection = fmt`\n\n📊 ${FormattedString.i("No open positions.")}`;
  }

  const kb = new InlineKeyboard()
    .text("📥 Deposit", "nav:deposit")
    .text("📤 Withdraw", "nav:withdraw")
    .row()
    .text("🟢 Long", "nav:long")
    .text("🔴 Short", "nav:short")
    .row()
    .text("📋 History", "nav:history");

  const msg = FormattedString.join([accountSection, positionsSection], "");
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
