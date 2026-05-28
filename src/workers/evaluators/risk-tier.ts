import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { MessageEntity } from "grammy/types";
import { type AlertButton, alertQueue } from "../../jobs/queues.js";
import { redis } from "../../lib/redis.js";
import type { RiskTier, TraderStateEvent } from "../../types/index.js";
import { isAlertEnabled } from "./shared.js";

const RISK_DEDUP_TTL = 300;

const RISK_ALERT_TIERS: RiskTier[] = [
  "atRisk",
  "at_risk",
  "cancellable",
  "liquidatable",
  "backstopLiquidatable",
  "highRisk",
];

interface AlertPayload {
  message: string;
  entities: MessageEntity[];
  keyboard: AlertButton[][];
  alertType: string;
}

function riskAlertType(tier: RiskTier): string {
  if (tier === "atRisk" || tier === "at_risk") return "at_risk";
  if (tier === "cancellable") return "cancellable";
  return "liquidatable";
}

// One open position → offer the two fastest de-risk actions inline.
function riskKb(event: TraderStateEvent): AlertButton[][] {
  const positions = event.positions ?? [];
  if (positions.length === 1) {
    const p = positions[0];
    return [
      [
        { text: "💰 Add margin", callback_data: `margin:${p.symbol}` },
        { text: "🛑 Add stop", callback_data: `tpsl:protect:${p.symbol}:${p.side}` },
      ],
      [{ text: "📊 Positions", callback_data: "nav:positions" }],
    ];
  }
  return [
    [
      { text: "📊 Positions", callback_data: "nav:positions" },
      { text: "📥 Deposit", callback_data: "nav:deposit" },
    ],
  ];
}

function buildRiskAlert(event: TraderStateEvent): AlertPayload | null {
  if (!RISK_ALERT_TIERS.includes(event.riskTier)) return null;
  const col = FormattedString.b(`$${Number(event.effectiveCollateral).toFixed(2)}`);
  const tier = event.riskTier;

  const messages: Partial<Record<RiskTier, FormattedString>> = {
    atRisk: fmt`⚠️ ${FormattedString.b("Margin Low")}\n\nYour collateral (${col}) dropped below initial margin.\nYou can't open new positions until you add funds or close existing ones.`,
    at_risk: fmt`⚠️ ${FormattedString.b("Margin Low")}\n\nYour collateral (${col}) dropped below initial margin.\nYou can't open new positions until you add funds or close existing ones.`,
    cancellable: fmt`🟠 ${FormattedString.b("Margin Warning")}\n\nYour collateral (${col}) is critically low.\nOpen orders may be force-cancelled to protect your account.`,
    liquidatable: fmt`🚨 ${FormattedString.b("Liquidation Risk")}\n\nYour account (${col}) can be liquidated.\nDeposit funds or close positions immediately.`,
    backstopLiquidatable: fmt`🆘 ${FormattedString.b("Liquidation Imminent")}\n\nYour account (${col}) is past the normal liquidation threshold.\nAct now — deposit or close everything.`,
    highRisk: fmt`🆘 ${FormattedString.b("Liquidation Imminent")}\n\nYour account (${col}) is deeply underwater.\nAct now — deposit or close everything.`,
  };

  const msg = messages[tier];
  if (!msg) return null;
  return {
    message: msg.text,
    entities: msg.entities,
    keyboard: riskKb(event),
    alertType: riskAlertType(tier),
  };
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
    entities: riskAlert.entities,
    keyboard: riskAlert.keyboard,
  });
}
