import { type AlertButton, alertQueue } from "../../jobs/queues.js";
import { redis } from "../../lib/redis.js";
import type { RiskTier, TraderStateEvent } from "../../types/index.js";
import { esc, isAlertEnabled } from "./shared.js";

const RISK_DEDUP_TTL = 300;

const RISK_ALERT_TIERS: RiskTier[] = [
  "atRisk",
  "at_risk",
  "cancellable",
  "liquidatable",
  "backstopLiquidatable",
  "highRisk",
];

const NAV_RISK_KB: AlertButton[][] = [
  [
    { text: "📊 Positions", callback_data: "nav:positions" },
    { text: "📥 Deposit", callback_data: "nav:deposit" },
  ],
];

interface AlertPayload {
  message: string;
  keyboard?: AlertButton[][];
}

function riskAlertType(tier: RiskTier): string {
  if (tier === "atRisk" || tier === "at_risk") return "at_risk";
  if (tier === "cancellable") return "cancellable";
  return "liquidatable";
}

function buildRiskAlert(event: TraderStateEvent): (AlertPayload & { alertType: string }) | null {
  if (!RISK_ALERT_TIERS.includes(event.riskTier)) return null;
  const col = esc(`$${Number(event.effectiveCollateral).toFixed(2)}`);
  const tier = event.riskTier;

  const messages: Record<string, string> = {
    atRisk: `⚠️ <b>Margin Low</b>\n\nYour collateral (${col}) dropped below initial margin.\nYou can't open new positions until you add funds or close existing ones.`,
    at_risk: `⚠️ <b>Margin Low</b>\n\nYour collateral (${col}) dropped below initial margin.\nYou can't open new positions until you add funds or close existing ones.`,
    cancellable: `🟠 <b>Margin Warning</b>\n\nYour collateral (${col}) is critically low.\nOpen orders may be force-cancelled to protect your account.`,
    liquidatable: `🚨 <b>Liquidation Risk</b>\n\nYour account (${col}) can be liquidated.\nDeposit funds or close positions immediately.`,
    backstopLiquidatable: `🆘 <b>Liquidation Imminent</b>\n\nYour account (${col}) is past the normal liquidation threshold.\nAct now — deposit or close everything.`,
    highRisk: `🆘 <b>Liquidation Imminent</b>\n\nYour account (${col}) is deeply underwater.\nAct now — deposit or close everything.`,
  };

  const msg = messages[tier];
  if (!msg) return null;
  return { message: msg, keyboard: NAV_RISK_KB, alertType: riskAlertType(tier) };
}

export async function evaluateRiskTier(
  _walletAddress: string,
  telegramId: string,
  userId: string,
  event: TraderStateEvent,
) {
  const riskAlert = buildRiskAlert(event);
  if (!riskAlert) return;

  if (!(await isAlertEnabled(userId, riskAlert.alertType))) return;

  const symbols = (event.positions ?? []).map((p) => p.symbol).join(",");
  const dedupKey = `ws:dedup:${telegramId}:risk:${riskAlert.alertType}`;
  const isNew = await redis.set(dedupKey, "1", "EX", RISK_DEDUP_TTL, "NX");
  if (!isNew) return;

  await alertQueue.add("risk-tier", {
    telegramId,
    type: riskAlert.alertType,
    symbol: symbols || undefined,
    message: riskAlert.message,
    keyboard: riskAlert.keyboard,
  });
}
