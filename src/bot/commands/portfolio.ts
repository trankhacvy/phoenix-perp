import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { getOrderbook } from "../../services/phoenix/market.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { getSolBalance, getWalletUsdcBalance } from "../../services/wallet.js";
import type { BotContext } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";
import { pnlEmoji, signedUsd, usd } from "../lib/fmt.js";
import { buildPositionRows } from "./positions.js";

const IDLE_USDC_THRESHOLD = 1;

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
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }
    if (!(await requireActivation(ctx))) return;
    await sendPortfolioScreen(ctx);
  });
}

export async function sendPortfolioScreen(ctx: BotContext, walletAddress?: string): Promise<void> {
  const targetWallet = walletAddress ?? ctx.user?.walletAddress;
  if (!targetWallet) return;
  const isOwn = !walletAddress || walletAddress === ctx.user?.walletAddress;

  const [state, sol, walletUsdc, solBook] = await Promise.all([
    getTraderState(targetWallet),
    getSolBalance(targetWallet),
    isOwn ? getWalletUsdcBalance(targetWallet).catch(() => 0) : Promise.resolve(0),
    getOrderbook("SOL").catch(() => null),
  ]);
  const solPrice = solBook?.mid ?? 0;
  const deposited = Number(state.depositedCollateral);
  const effective = Number(state.effectiveCollateral);
  const upnl = Number(state.unrealizedPnl);
  const funding = Number(state.unsettledFunding);
  const totalValue = effective + upnl + funding;
  const tier = String(state.riskTier ?? "safe");
  const tierStr = `${riskEmoji[tier] ?? "⚪"} ${riskLabel[tier] ?? tier}`;
  const hasIdleUsdc = isOwn && walletUsdc >= IDLE_USDC_THRESHOLD;

  const sections: FormattedString[] = [];

  // ── Balances (two pockets) ───────────────────────────────────────────────────
  if (isOwn) {
    sections.push(
      FormattedString.join(
        [
          fmt`💼 ${FormattedString.b("Balances")}`,
          fmt`💰 Wallet            ${FormattedString.b(usd(walletUsdc))} USDC`,
          fmt`📊 Trading account   ${FormattedString.b(usd(deposited))}`,
        ],
        "\n",
      ),
    );

    if (hasIdleUsdc) {
      sections.push(
        fmt`⚠️ ${FormattedString.b(`${usd(walletUsdc)} sitting idle in your wallet.`)} Tap ${FormattedString.b("Add Collateral")} below to start trading with it.`,
      );
    }
  }

  // ── Trading account ──────────────────────────────────────────────────────────
  const solGasLine =
    solPrice > 0
      ? fmt`⛽ Gas         ${FormattedString.b(`${sol.toFixed(4)} SOL`)}  ${FormattedString.i(`(${usd(sol * solPrice)})`)} `
      : fmt`⛽ Gas         ${FormattedString.b(`${sol.toFixed(4)} SOL`)}`;
  sections.push(
    FormattedString.join(
      [
        fmt`📊 ${FormattedString.b("Trading account")}`,
        fmt`Collateral   ${FormattedString.b(usd(deposited))}`,
        fmt`Available    ${FormattedString.b(usd(effective))}`,
        fmt`Total value  ${FormattedString.b(usd(totalValue))}`,
        solGasLine,
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
        fmt`${FormattedString.code(targetWallet)}`,
        fmt`${FormattedString.i("(tap to copy)")}`,
        fmt`${tierStr}`,
      ],
      "\n",
    ),
  );

  const msg = FormattedString.join(sections, "\n\n");

  const kb = isOwn
    ? (() => {
        const k = new InlineKeyboard().text("📥 Deposit", "nav:deposit");
        if (hasIdleUsdc) k.text("💰 Add Collateral", "deposit:fund");
        else k.text("📤 Withdraw", "nav:withdraw");
        k.row()
          .text("🟢 Long", "nav:long")
          .text("🔴 Short", "nav:short")
          .row()
          .text("📊 Positions", "nav:positions")
          .text("📋 History", "nav:history");
        if (hasIdleUsdc) k.row().text("📤 Withdraw", "nav:withdraw");
        return k;
      })()
    : new InlineKeyboard()
        .text("📋 Trade History", `walletinfo:histopen:${targetWallet}`)
        .row()
        .text("👁 Follow", `walletinfo:follow:${targetWallet}`);

  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}
