import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";
import { getTraderState } from "../../services/phoenix/position.js";
import type { BotContext } from "../../types/index.js";
import { pnlEmoji, shortAddr, signedUsd, usd } from "../lib/fmt.js";
import { buildPositionRows } from "./positions.js";

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

export function registerPortfolio(bot: Bot<BotContext>) {
  bot.command("portfolio", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Type /start first.");
      return;
    }
    await sendPortfolioScreen(ctx);
  });
}

export async function sendPortfolioScreen(ctx: BotContext, walletAddress?: string): Promise<void> {
  const targetWallet = walletAddress ?? ctx.user?.walletAddress;
  if (!targetWallet) return;
  const isOwn = !walletAddress || walletAddress === ctx.user?.walletAddress;

  const [state, solLamports] = await Promise.all([
    getTraderState(targetWallet),
    solConnection.getBalance(new PublicKey(targetWallet)).catch(() => 0),
  ]);

  const sol = solLamports / 1e9;
  const deposited = Number(state.depositedCollateral);
  const effective = Number(state.effectiveCollateral);
  const upnl = Number(state.unrealizedPnl);
  const funding = Number(state.unsettledFunding);
  const totalValue = effective + upnl + funding;
  const tier = String(state.riskTier ?? "safe");
  const tierStr = `${riskEmoji[tier] ?? "⚪"} ${riskLabel[tier] ?? tier}`;

  const sections: FormattedString[] = [];

  // ── Account ──────────────────────────────────────────────────────────────────
  sections.push(
    FormattedString.join(
      [
        fmt`💼 ${FormattedString.b("Account")}`,
        fmt`Collateral   ${FormattedString.b(usd(deposited))}`,
        fmt`Available    ${FormattedString.b(usd(effective))}`,
        fmt`Total value  ${FormattedString.b(usd(totalValue))}`,
      ],
      "\n",
    ),
  );

  // ── Open P&L ─────────────────────────────────────────────────────────────────
  const net = upnl + funding;
  sections.push(
    FormattedString.join(
      [
        fmt`📈 ${FormattedString.b("Open P&L")}`,
        fmt`Unrealized      ${FormattedString.b(signedUsd(upnl))} ${pnlEmoji(upnl)}`,
        fmt`Pending funding ${FormattedString.b(signedUsd(funding))}`,
        fmt`Net             ${FormattedString.b(signedUsd(net))} ${pnlEmoji(net)}`,
      ],
      "\n",
    ),
  );

  // ── Positions ────────────────────────────────────────────────────────────────
  const positions = state.positions ?? [];
  const botUsername = ctx.me.username ?? "bot";
  if (positions.length === 0) {
    sections.push(fmt`📊 ${FormattedString.i("No open positions.")}`);
  } else {
    const shown = positions.slice(0, 5);
    const rest = positions.length - shown.length;
    const posLines: FormattedString[] = [
      fmt`📊 ${FormattedString.b(`Positions (${positions.length})`)}`,
      ...buildPositionRows(shown, botUsername),
    ];
    if (rest > 0) posLines.push(fmt`${FormattedString.i(`+ ${rest} more — use /positions`)}`);
    sections.push(FormattedString.join(posLines, "\n\n"));
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  sections.push(
    FormattedString.join(
      [
        fmt`⛽ ${FormattedString.b(`${sol.toFixed(4)} SOL`)}`,
        fmt`${FormattedString.code(shortAddr(targetWallet))}`,
        fmt`${tierStr}`,
      ],
      "\n",
    ),
  );

  const msg = FormattedString.join(sections, "\n\n");

  const kb = isOwn
    ? new InlineKeyboard()
        .text("📥 Deposit", "nav:deposit")
        .text("📤 Withdraw", "nav:withdraw")
        .row()
        .text("🟢 Long", "nav:long")
        .text("🔴 Short", "nav:short")
        .row()
        .text("📊 Positions", "nav:positions")
        .text("📋 History", "nav:history")
    : new InlineKeyboard()
        .text("📋 Trade History", `walletinfo:hist:${targetWallet}:0`)
        .row()
        .text("👁 Monitor", `monitor:add:${targetWallet}`);

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
