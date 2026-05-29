import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { GuardianRule } from "../../db/schema/guardian.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import {
  createRule,
  deleteAllRules,
  deleteRule,
  disableAllAutoActions,
  generateRuleId,
  getUserRules,
  toggleRule,
} from "../../services/guardian.js";
import { getPositionConditionals } from "../../services/phoenix/conditional.js";
import { getMarkets, isIsolatedOnly } from "../../services/phoenix/market.js";
import { getTraderState } from "../../services/phoenix/position.js";
import { addMargin, closePosition, getFeeConfig } from "../../services/phoenix/trade.js";
import { getSettings } from "../../services/settings.js";
import type { BotContext, PhoenixPosition } from "../../types/index.js";
import { requireActivation } from "../lib/activation.js";
import { renderBotError } from "../lib/errors.js";
import { price as fmtPrice, money, moneyShort, num, pct, signedMoney, usd } from "../lib/fmt.js";
import { claimIdempotencyKey } from "../lib/idempotent.js";
import { setPending } from "../lib/pending.js";
import { CONFIRMING, TX_MSG_OPTS, txError, txSuccess } from "../lib/tx-flow.js";
import { checkOrderRateLimit } from "../middleware/rate-limit.js";

const TYPE_LABELS: Record<string, { icon: string; name: string }> = {
  liq_distance: { icon: "⚡", name: "Liq distance" },
  drawdown: { icon: "📉", name: "Drawdown" },
  pnl_target: { icon: "🎯", name: "PnL target" },
  funding_drain: { icon: "💸", name: "Funding cost" },
  exposure_limit: { icon: "📊", name: "Exposure limit" },
  margin_ratio: { icon: "📊", name: "Margin ratio" },
};

const ACTION_LABELS: Record<string, string> = {
  notify: "Notify only",
  suggest: "Notify + action buttons",
  auto_close: "⚡ Auto-close 100%",
  auto_reduce: "⚡ Auto-reduce",
  auto_margin: "⚡ Auto-add margin",
};

function typeInfo(ruleType: string) {
  return TYPE_LABELS[ruleType] ?? { icon: "🔔", name: ruleType };
}

function ruleOneLiner(rule: GuardianRule): string {
  const t = typeInfo(rule.ruleType);
  const sym = rule.symbol ?? "All";
  const th = Number(rule.threshold);
  const enabled = rule.enabled ? "✅" : "❌";

  let trigger = "";
  if (rule.ruleType === "liq_distance") trigger = `< ${th}%`;
  else if (rule.ruleType === "drawdown") trigger = `> ${th}% from peak`;
  else if (rule.ruleType === "pnl_target")
    trigger = rule.direction === "above" ? `+${th}%` : `−${th}%`;
  else if (rule.ruleType === "funding_drain") trigger = `> $${th}/day`;
  else if (rule.ruleType === "exposure_limit") trigger = `> ${moneyShort(th)}`;
  else if (rule.ruleType === "margin_ratio") trigger = `< ${th}%`;

  return `${enabled} ${sym} — ${t.name} ${trigger}`;
}

function actionOneLiner(rule: GuardianRule): string {
  let label = ACTION_LABELS[rule.action] ?? rule.action;
  if (rule.action === "auto_reduce" && rule.actionParam)
    label = `⚡ Auto-reduce ${Number(rule.actionParam)}%`;
  if (rule.action === "auto_margin" && rule.actionParam)
    label = `⚡ Auto-add $${Number(rule.actionParam)}`;
  return `→ ${label} · ${Math.round(rule.cooldownSec / 60)}min cooldown`;
}

async function sendGuardianScreen(ctx: BotContext, edit = false) {
  if (!ctx.user) return;
  const [rules, state] = await Promise.all([
    getUserRules(ctx.user.id),
    getTraderState(ctx.user.walletAddress).catch(() => null),
  ]);
  const positions = state?.positions ?? [];

  const botUsername = ctx.me.username ?? "bot";
  let msg: FormattedString;
  const kb = new InlineKeyboard();

  if (rules.length === 0) {
    msg = fmt`🛡 ${FormattedString.b("Risk Guardian")}

No active rules. Your positions are running unprotected.

Open a position and tap 🛡 Protect to add a stop, trailing stop, or auto-rule — or add an account-wide rule below.`;
  } else {
    const lines = rules.map((r) => {
      const link = FormattedString.link(
        ruleOneLiner(r),
        `https://t.me/${botUsername}?start=grd_${r.id}`,
      );
      return fmt`${link}\n   ${actionOneLiner(r)}`;
    });
    msg = FormattedString.join(
      [
        fmt`🛡 ${FormattedString.b(`Risk Guardian (${rules.length} rules)`)}`,
        fmt`${FormattedString.i("Tap a rule to edit, pause, or delete it.")}`,
        ...lines,
      ],
      "\n\n",
    );
  }

  if (positions.length > 0) {
    kb.text("🛡 Protect a position", "nav:positions").row();
  }
  kb.text("+ Account rule", "grd:new").text("📋 Presets", "grd:preset").row();
  const hasAuto = rules.some(
    (r) => r.action === "auto_close" || r.action === "auto_reduce" || r.action === "auto_margin",
  );
  if (hasAuto) kb.text("⏸ Disable all auto-actions", "grd:killswitch").row();
  if (rules.length > 0) kb.text("🗑 Remove all rules", "grd:rmall").row();
  kb.text("🔔 Alerts", "al:main").text("✕ Close", "grd:close_menu");

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) await ctx.editMessageText(msg.text, opts);
  else await ctx.reply(msg.text, opts);
}

async function sendPresetScreen(ctx: BotContext) {
  const msg = fmt`🛡 ${FormattedString.b("Choose a protection level")}

These create rules for all your positions at once.
You can customize them later.

${FormattedString.b("🟢 Conservative")}
  Liq distance < 15% → notify + actions
  Drawdown > 10% → notify + actions

${FormattedString.b("🟡 Moderate")}
  Liq distance < 10% → notify + actions
  Drawdown > 20% → notify only

${FormattedString.b("🔴 Aggressive")}
  Liq distance < 5% → notify only`;

  const kb = new InlineKeyboard()
    .text("🟢 Conservative", "grd:presetgo:conservative")
    .text("🟡 Moderate", "grd:presetgo:moderate")
    .text("🔴 Aggressive", "grd:presetgo:aggressive")
    .row()
    .text("← Back", "grd:list");

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

interface PresetDef {
  ruleType: GuardianRule["ruleType"];
  threshold: string;
  direction: string;
  action: GuardianRule["action"];
}

const PRESETS: Record<string, PresetDef[]> = {
  conservative: [
    { ruleType: "liq_distance", threshold: "15", direction: "below", action: "suggest" },
    { ruleType: "drawdown", threshold: "10", direction: "above", action: "suggest" },
  ],
  moderate: [
    { ruleType: "liq_distance", threshold: "10", direction: "below", action: "suggest" },
    { ruleType: "drawdown", threshold: "20", direction: "above", action: "notify" },
  ],
  aggressive: [{ ruleType: "liq_distance", threshold: "5", direction: "below", action: "notify" }],
};

async function applyPreset(ctx: BotContext, level: string) {
  if (!ctx.user) return;
  const defs = PRESETS[level];
  if (!defs) return;

  for (const def of defs) {
    await createRule({
      id: generateRuleId(),
      userId: ctx.user.id,
      ruleType: def.ruleType,
      symbol: null,
      threshold: def.threshold,
      direction: def.direction,
      action: def.action,
    });
  }

  const levelLabels: Record<string, string> = {
    conservative: "🟢 Conservative",
    moderate: "🟡 Moderate",
    aggressive: "🔴 Aggressive",
  };

  const lines = defs.map(
    (d) =>
      `  • ${typeInfo(d.ruleType).name} ${d.ruleType === "liq_distance" ? "<" : ">"} ${d.threshold}% → ${ACTION_LABELS[d.action]}`,
  );

  const msg = fmt`✅ ${FormattedString.b(`${levelLabels[level]} protection activated`)}

Created ${String(defs.length)} rules:
${lines.join("\n")}

You'll get alerts when any position hits these thresholds.`;

  const kb = new InlineKeyboard()
    .text("🛡 View rules", "grd:list")
    .text("📊 Positions", "nav:positions");

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendRuleTypePicker(ctx: BotContext) {
  const msg = fmt`🛡 ${FormattedString.b("Account rule — what should I watch?")}

These apply to your whole account, not one position.
To protect a single position, open it and tap 🛡 Protect.`;

  const kb = new InlineKeyboard()
    .text("📊 Total Exposure — combined size cap", "grd:type:exposure_limit")
    .row()
    .text("🛟 Margin Health — collateral too thin", "grd:type:margin_ratio")
    .row()
    .text("← Back", "grd:list");

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendSymbolPicker(ctx: BotContext, ruleType: string) {
  if (!ctx.user) return;

  const kb = new InlineKeyboard().text("All positions", `grd:sym:${ruleType}:_all`).row();

  try {
    const state = await getTraderState(ctx.user.walletAddress);
    const symbols = [...new Set(state.positions.map((p) => p.symbol))];
    if (symbols.length > 0) {
      for (let i = 0; i < symbols.length; i += 2) {
        kb.text(symbols[i], `grd:sym:${ruleType}:${symbols[i]}`);
        if (symbols[i + 1]) kb.text(symbols[i + 1], `grd:sym:${ruleType}:${symbols[i + 1]}`);
        kb.row();
      }
    } else {
      const markets = await getMarkets();
      const top = markets.slice(0, 6);
      for (let i = 0; i < top.length; i += 2) {
        kb.text(top[i].symbol, `grd:sym:${ruleType}:${top[i].symbol}`);
        if (top[i + 1]) kb.text(top[i + 1].symbol, `grd:sym:${ruleType}:${top[i + 1].symbol}`);
        kb.row();
      }
    }
  } catch {
    const markets = await getMarkets();
    for (const m of markets.slice(0, 6)) {
      kb.text(m.symbol, `grd:sym:${ruleType}:${m.symbol}`).row();
    }
  }

  kb.text("← Back", "grd:new");

  const t = typeInfo(ruleType);
  const msg = fmt`🛡 ${FormattedString.b(`${t.name} Rule — Which position?`)}`;
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendThresholdPicker(ctx: BotContext, ruleType: string, symbol: string) {
  const t = typeInfo(ruleType);
  const symLabel = symbol === "_all" ? "All" : symbol;
  const kb = new InlineKeyboard();

  let explanation = "";

  if (ruleType === "drawdown") {
    explanation = "Alert when unrealized PnL drops this much from its highest point.";
    for (const v of [5, 10, 15, 20]) kb.text(`${v}%`, `grd:th:${ruleType}:${symbol}:${v}`);
    kb.row();
  } else if (ruleType === "liq_distance") {
    explanation = "Alert when liquidation price is within this % of mark price.";
    for (const v of [5, 10, 15, 20]) kb.text(`${v}%`, `grd:th:${ruleType}:${symbol}:${v}`);
    kb.row();
  } else if (ruleType === "pnl_target") {
    explanation = "Alert when position PnL (% of margin) hits this level.";
    for (const v of [25, 50, 100, 200]) kb.text(`+${v}%`, `grd:th:${ruleType}:${symbol}:+${v}`);
    kb.row();
    for (const v of [10, 25, 50]) kb.text(`−${v}%`, `grd:th:${ruleType}:${symbol}:-${v}`);
    kb.row();
  } else if (ruleType === "funding_drain") {
    explanation = "Alert when daily funding cost exceeds this amount.";
    for (const v of [5, 10, 25, 50]) kb.text(`$${v}/day`, `grd:th:${ruleType}:${symbol}:${v}`);
    kb.row();
  } else if (ruleType === "exposure_limit") {
    explanation = "Alert when total position value exceeds:";
    for (const v of [10000, 25000, 50000, 100000])
      kb.text(moneyShort(v), `grd:th:${ruleType}:${symbol}:${v}`);
    kb.row();
  } else if (ruleType === "margin_ratio") {
    explanation = "Alert when account collateral vs total exposure drops below:";
    for (const v of [10, 15, 20, 25]) kb.text(`${v}%`, `grd:th:${ruleType}:${symbol}:${v}`);
    kb.row();
  }

  const accountType = ruleType === "exposure_limit" || ruleType === "margin_ratio";
  kb.text("✏️ Custom", `grd:thc:${ruleType}:${symbol}`).row();
  kb.text("← Back", accountType ? "grd:new" : `grd:type:${ruleType}`);

  const msg = fmt`🛡 ${FormattedString.b(`${t.icon} ${t.name} — ${symLabel}`)}

${explanation}`;

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendActionPicker(
  ctx: BotContext,
  ruleType: string,
  symbol: string,
  threshold: string,
) {
  const t = typeInfo(ruleType);
  const symLabel = symbol === "_all" ? "All" : symbol;

  const msg = fmt`🛡 ${FormattedString.b(`${t.name} — ${symLabel} > ${threshold}`)}

When this triggers, what should I do?`;

  const base = `grd:act:${ruleType}:${symbol}:${threshold}`;
  const kb = new InlineKeyboard()
    .text("🔔 Notify only", `${base}:notify`)
    .row()
    .text("🔔 Suggest actions", `${base}:suggest`)
    .row()
    .text("⚡ Auto-close", `${base}:auto_close`)
    .row()
    .text("⚡ Auto-reduce", `${base}:auto_reduce`)
    .row()
    .text("⚡ Auto-add margin", `${base}:auto_margin`)
    .row()
    .text("← Back", `grd:th_back:${ruleType}:${symbol}`);

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

function parseThreshold(raw: string): { direction: string; value: number } | null {
  if (raw.startsWith("+")) return { direction: "above", value: Number(raw.slice(1)) };
  if (raw.startsWith("-")) return { direction: "below", value: Math.abs(Number(raw.slice(1))) };
  const n = Number(raw);
  if (Number.isNaN(n) || n <= 0) return null;
  return { direction: "below", value: n };
}

function directionForType(ruleType: string, thresholdStr: string): string {
  if (ruleType === "pnl_target") {
    return thresholdStr.startsWith("+") ? "above" : "below";
  }
  if (ruleType === "liq_distance" || ruleType === "margin_ratio") return "below";
  return "above";
}

async function sendAutoConfirm(
  ctx: BotContext,
  ruleType: string,
  symbol: string,
  threshold: string,
  action: string,
  actionParam: string | null,
) {
  const t = typeInfo(ruleType);
  const symLabel = symbol === "_all" ? "All" : symbol;

  let actionDesc = "";
  if (action === "auto_close") actionDesc = `Market-close 100% of your ${symLabel} position`;
  else if (action === "auto_reduce")
    actionDesc = `Market-close ${actionParam ?? "50"}% of your ${symLabel} position`;
  else if (action === "auto_margin")
    actionDesc = `Deposit $${actionParam ?? "100"} from your wallet`;

  const msg = fmt`⚠️ ${FormattedString.b("Auto-Action Confirmation")}

You're enabling automatic execution. When triggered:

  • ${actionDesc}
  • Uses your Privy wallet to sign
  • No confirmation prompt

Disable anytime via /guardian off

Rule: ${symLabel} ${t.name} ${threshold}`;

  const encoded = `${ruleType}:${symbol}:${threshold}:${action}:${actionParam ?? ""}`;
  const kb = new InlineKeyboard()
    .text("✅ I understand, enable", `grd:save:${encoded}`)
    .row()
    .text("← Go back, use notify", `grd:act_back:${ruleType}:${symbol}:${threshold}`);

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendReducePicker(
  ctx: BotContext,
  ruleType: string,
  symbol: string,
  threshold: string,
) {
  const base = `grd:autoparam:${ruleType}:${symbol}:${threshold}:auto_reduce`;
  const kb = new InlineKeyboard()
    .text("25%", `${base}:25`)
    .text("50%", `${base}:50`)
    .text("75%", `${base}:75`)
    .row()
    .text("← Back", `grd:act_back:${ruleType}:${symbol}:${threshold}`);

  const msg = fmt`⚡ ${FormattedString.b("Auto-Reduce — how much to close?")}`;
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendMarginPicker(
  ctx: BotContext,
  ruleType: string,
  symbol: string,
  threshold: string,
) {
  const base = `grd:autoparam:${ruleType}:${symbol}:${threshold}:auto_margin`;
  const kb = new InlineKeyboard()
    .text("$50", `${base}:50`)
    .text("$100", `${base}:100`)
    .text("$200", `${base}:200`)
    .text("$500", `${base}:500`)
    .row()
    .text("✏️ Custom $", `grd:margincustom:${ruleType}:${symbol}:${threshold}`)
    .row()
    .text("← Back", `grd:act_back:${ruleType}:${symbol}:${threshold}`);

  const msg = fmt`⚡ ${FormattedString.b("Auto-Add Margin — how much USDC?")}

Amount will be transferred from your bot wallet into your trading account when the rule triggers.`;
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendConfirmScreen(
  ctx: BotContext,
  ruleType: string,
  symbol: string,
  threshold: string,
  action: string,
  actionParam: string | null,
) {
  const t = typeInfo(ruleType);
  const symLabel = symbol === "_all" ? "All" : symbol;
  const parsed = parseThreshold(threshold);
  const thVal = parsed?.value ?? Number(threshold);

  let triggerDesc = "";
  if (ruleType === "drawdown") triggerDesc = `PnL drops ${thVal}% from peak`;
  else if (ruleType === "liq_distance") triggerDesc = `Liq distance < ${thVal}%`;
  else if (ruleType === "pnl_target")
    triggerDesc =
      parsed?.direction === "above" ? `PnL reaches +${thVal}%` : `PnL drops to −${thVal}%`;
  else if (ruleType === "funding_drain") triggerDesc = `Funding > $${thVal}/day`;
  else if (ruleType === "exposure_limit") triggerDesc = `Exposure > ${moneyShort(thVal)}`;
  else if (ruleType === "margin_ratio") triggerDesc = `Margin ratio < ${thVal}%`;

  let actionLabel = ACTION_LABELS[action] ?? action;
  if (action === "auto_reduce" && actionParam) actionLabel = `⚡ Auto-reduce ${actionParam}%`;
  if (action === "auto_margin" && actionParam) actionLabel = `⚡ Auto-add $${actionParam}`;

  const isAuto = action.startsWith("auto_");

  const msg = fmt`🛡 ${FormattedString.b("Rule Summary")}

${t.icon} ${FormattedString.b(`${t.name} — ${symLabel}`)}
Trigger: ${triggerDesc}
Action: ${actionLabel}
Cooldown: 5 minutes${isAuto ? "\n\n⚠️ This will execute automatically without confirmation." : ""}`;

  const encoded = `${ruleType}:${symbol}:${threshold}:${action}:${actionParam ?? ""}`;
  const kb = new InlineKeyboard()
    .text("✅ Save rule", `grd:save:${encoded}`)
    .text("✕ Cancel", "grd:list");

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

export async function sendRuleDetail(ctx: BotContext, ruleId: string, edit = true) {
  if (!ctx.user) return;

  const rules = await getUserRules(ctx.user.id);
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) {
    if (edit && ctx.callbackQuery) await ctx.answerCallbackQuery("Rule not found.");
    else await ctx.reply("Rule not found — it may have been removed.");
    return;
  }

  const t = typeInfo(rule.ruleType);
  const sym = rule.symbol ?? "All";
  const status = rule.enabled ? "✅ Active" : "❌ Paused";
  const lastTriggered = rule.lastTriggeredAt ? timeSince(rule.lastTriggeredAt.getTime()) : "never";

  const msg = fmt`🛡 ${FormattedString.b("Rule Detail")}

${t.icon} ${FormattedString.b(`${t.name} — ${sym}`)}
Status: ${status}
Trigger: ${ruleOneLiner(rule).split(" — ")[1] ?? ""}
Action: ${actionOneLiner(rule).slice(2)}
Last triggered: ${lastTriggered}`;

  const kb = new InlineKeyboard()
    .text("✏️ Change threshold", `grd:edit:th:${ruleId}`)
    .text("✏️ Change action", `grd:edit:act:${ruleId}`)
    .row()
    .text(rule.enabled ? "⏸ Pause rule" : "▶️ Resume rule", `grd:toggle:${ruleId}`)
    .text("🗑 Delete rule", `grd:rm:${ruleId}`)
    .row()
    .text("← Back", "grd:list");

  const opts = { entities: msg.entities, reply_markup: kb };
  if (edit && ctx.callbackQuery) await ctx.editMessageText(msg.text, opts);
  else await ctx.reply(msg.text, opts);
}

function timeSince(tsMs: number): string {
  const diff = Math.floor((Date.now() - tsMs) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Protect hub (per-position, context-first) ─────────────────────────
interface ProtectPos {
  pos: PhoenixPosition;
  margin: number;
  mark: number;
  entry: number;
  liq: number;
  liqDistPct: number | null;
}

function liqDot(distPct: number): string {
  if (distPct < 5) return "🔴";
  if (distPct < 12) return "🟡";
  return "🟢";
}

async function loadProtectPos(
  ctx: BotContext,
  symbol: string,
  side: "long" | "short",
): Promise<ProtectPos | null> {
  if (!ctx.user) return null;
  const state = await getTraderState(ctx.user.walletAddress);
  const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);
  if (!pos) return null;
  const mark = Number(pos.markPrice);
  const entry = Number(pos.entryPrice);
  const size = Number(pos.size);
  const lev = pos.leverage && pos.leverage > 0 ? pos.leverage : 1;
  const margin = (mark * size) / lev;
  const liq = pos.liquidationPrice === "N/A" ? 0 : Number(pos.liquidationPrice);
  const liqDistPct =
    liq > 0 && mark > 0
      ? side === "long"
        ? ((mark - liq) / mark) * 100
        : ((liq - mark) / mark) * 100
      : null;
  return { pos, margin, mark, entry, liq, liqDistPct };
}

function protectHeader(p: ProtectPos): FormattedString {
  const markPct = p.entry > 0 ? ((p.mark - p.entry) / p.entry) * 100 : 0;
  const liqLine =
    p.liq > 0 && p.liqDistPct !== null
      ? fmt`Liq        ${FormattedString.b(fmtPrice(p.liq))}  ·  ${num(Math.max(0, p.liqDistPct), 1, 1)}% away ${liqDot(p.liqDistPct)}`
      : fmt`Liq        ${FormattedString.b("Safe ✅")}`;
  return fmt`Margin     ${FormattedString.b(usd(p.margin))}
Mark       ${FormattedString.b(fmtPrice(p.mark))}  (${pct(markPct)} vs entry ${fmtPrice(p.entry)})
${liqLine}`;
}

async function sendProtectHub(ctx: BotContext, symbol: string, side: "long" | "short") {
  if (!ctx.user) return;
  const sideLabel = side === "long" ? "LONG" : "SHORT";

  const [pp, rungs, rules] = await Promise.all([
    loadProtectPos(ctx, symbol, side),
    getPositionConditionals(ctx.user.walletAddress, symbol, side).catch(() => []),
    getUserRules(ctx.user.id),
  ]);

  if (!pp) {
    await ctx.editMessageText(`No open ${symbol} ${sideLabel} position.`, {
      reply_markup: new InlineKeyboard().text("📊 Positions", "nav:positions"),
    });
    return;
  }

  const slCount = rungs.filter((r) => r.leg === "sl").length;
  const tpCount = rungs.filter((r) => r.leg === "tp").length;
  const symbolRules = rules.filter(
    (r) => r.enabled && r.symbol === symbol && (!r.side || r.side === side),
  );
  const trailRule = symbolRules.find((r) => r.ruleType === "trailing_stop");
  const beRule = symbolRules.find((r) => r.ruleType === "breakeven");
  const autoCount = symbolRules.filter(
    (r) => r.ruleType !== "trailing_stop" && r.ruleType !== "breakeven",
  ).length;

  const slStatus = slCount > 0 ? `${slCount} level${slCount > 1 ? "s" : ""}` : "⚠️ not set";
  const tpStatus = tpCount > 0 ? `${tpCount} level${tpCount > 1 ? "s" : ""}` : "not set";
  const trailStatus = trailRule ? `on · ${Number(trailRule.threshold)}% trail` : "off";
  const beStatus = beRule ? `armed at +${Number(beRule.threshold)}%` : "off";
  const autoStatus = autoCount > 0 ? `${autoCount} rule${autoCount > 1 ? "s" : ""}` : "none";

  const msg = fmt`🛡 ${FormattedString.b(`Protect ${symbol} · ${sideLabel}`)}

${protectHeader(pp)}
━━━━━━━━━━━━━━━━━━━━━━━━━
${FormattedString.b("Currently set")}
  🛑 Stop loss     ${slStatus}
  🎯 Take profit   ${tpStatus}
  🛟 Trailing      ${trailStatus}
  🎯 Breakeven     ${beStatus}
  ⚡ Auto-rules    ${autoStatus}
━━━━━━━━━━━━━━━━━━━━━━━━━
${FormattedString.i("🛑 Stop loss caps your downside · 🎯 Take profit banks gains")}
${FormattedString.i("🛟 Trailing follows price up · 🎯 Breakeven locks in no-loss")}
${FormattedString.i("⚡ Auto-protect alerts or acts on rules you set")}`;

  const kb = new InlineKeyboard()
    .text("🛑 Stop loss", `tpsl:open:sl:${symbol}:${side}`)
    .text("🎯 Take profit", `tpsl:open:tp:${symbol}:${side}`)
    .row()
    .text("🛟 Trailing stop", `protect:trail:${symbol}:${side}`)
    .text("🎯 Move to breakeven", `protect:be:${symbol}:${side}`)
    .row()
    .text("⚡ Auto-protect / alerts", `protect:auto:${symbol}:${side}`)
    .row()
    .text("← Back to position", `pos:detail:${symbol}:${side}`);

  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

const TRAIL_PRESETS = [3, 5, 10] as const;
const BE_PRESETS = [20, 30, 50] as const;

function trailInitialStop(side: "long" | "short", mark: number, pct: number): number {
  return side === "long" ? mark * (1 - pct / 100) : mark * (1 + pct / 100);
}

function trailStopSafe(side: "long" | "short", stop: number, liq: number): boolean {
  if (liq <= 0) return true;
  return side === "long" ? stop > liq : stop < liq;
}

async function sendTrailPicker(ctx: BotContext, symbol: string, side: "long" | "short") {
  const pp = await loadProtectPos(ctx, symbol, side);
  if (!pp) {
    await ctx.editMessageText(`No open ${symbol} ${side.toUpperCase()} position.`, {
      reply_markup: new InlineKeyboard().text("📊 Positions", "nav:positions"),
    });
    return;
  }

  const base = `protect:trailgo:${symbol}:${side}`;
  const kb = new InlineKeyboard();
  let n = 0;
  for (const p of TRAIL_PRESETS) {
    const stop = trailInitialStop(side, pp.mark, p);
    if (!trailStopSafe(side, stop, pp.liq)) continue;
    kb.text(`${p}% (${fmtPrice(stop)})`, `${base}:${p}`);
    n++;
  }
  if (n > 0) kb.row();
  kb.text("✏️ Custom %", `protect:trailc:${symbol}:${side}`).row();
  kb.text("← Back", `protect:${symbol}:${side}`);

  const msg = fmt`🛟 ${FormattedString.b(`Trailing stop — ${symbol} ${side.toUpperCase()}`)}

${protectHeader(pp)}
━━━━━━━━━━━━━━━━━━━━━━━━━
Your stop follows the price up and never down — locking in gains.
The price shown is where your stop starts now; it ratchets as price moves.`;
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendBreakevenPicker(ctx: BotContext, symbol: string, side: "long" | "short") {
  const pp = await loadProtectPos(ctx, symbol, side);
  if (!pp) {
    await ctx.editMessageText(`No open ${symbol} ${side.toUpperCase()} position.`, {
      reply_markup: new InlineKeyboard().text("📊 Positions", "nav:positions"),
    });
    return;
  }

  const base = `protect:bego:${symbol}:${side}`;
  const kb = new InlineKeyboard();
  for (const p of BE_PRESETS) {
    const profit = (pp.margin * p) / 100;
    kb.text(`+${p}% (+${usd(profit)})`, `${base}:${p}`);
  }
  kb.row();
  kb.text("✏️ Custom %", `protect:bec:${symbol}:${side}`).row();
  kb.text("← Back", `protect:${symbol}:${side}`);

  const msg = fmt`🎯 ${FormattedString.b(`Move to breakeven — ${symbol} ${side.toUpperCase()}`)}

${protectHeader(pp)}
━━━━━━━━━━━━━━━━━━━━━━━━━
Once profit reaches the level you pick, your on-chain stop moves to
your entry (~${fmtPrice(pp.entry)}) — so the trade can't turn into a loss.`;
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendAutoTriggerPicker(ctx: BotContext, symbol: string, side: "long" | "short") {
  const msg = fmt`⚡ ${FormattedString.b(`Auto-protect ${symbol} ${side.toUpperCase()}`)}

Pick a trigger — next you'll choose notify-only or an auto-action.`;
  const kb = new InlineKeyboard()
    .text("⚡ Near liquidation", `protect:trig:liq_distance:${symbol}:${side}`)
    .row()
    .text("📉 Gives back profit", `protect:trig:drawdown:${symbol}:${side}`)
    .row()
    .text("🎯 Hits a P&L level", `protect:trig:pnl_target:${symbol}:${side}`)
    .row()
    .text("💸 Funding too expensive", `protect:trig:funding_drain:${symbol}:${side}`)
    .row()
    .text("← Back", `protect:${symbol}:${side}`);
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function sendProtectThreshold(
  ctx: BotContext,
  ruleType: string,
  symbol: string,
  side: "long" | "short",
) {
  const pp = await loadProtectPos(ctx, symbol, side);
  if (!pp) {
    await ctx.editMessageText(`No open ${symbol} ${side.toUpperCase()} position.`, {
      reply_markup: new InlineKeyboard().text("📊 Positions", "nav:positions"),
    });
    return;
  }
  const t = typeInfo(ruleType);
  const kb = new InlineKeyboard();
  let explain = "";

  if (ruleType === "liq_distance") {
    const distNow = pp.liqDistPct !== null ? `${num(Math.max(0, pp.liqDistPct), 1, 1)}%` : "—";
    explain = `Trigger when your liquidation gets within this % of price.\nLiq ${fmtPrice(pp.liq)} · currently ${distNow} away — pick a number below that.`;
    for (const v of [5, 10, 15, 20]) kb.text(`${v}%`, `grd:th:${ruleType}:${symbol}:${v}`);
    kb.row();
  } else if (ruleType === "drawdown") {
    explain = "Trigger when profit falls this % from its peak (only once you're in profit).";
    for (const v of [5, 10, 15, 20]) kb.text(`${v}%`, `grd:th:${ruleType}:${symbol}:${v}`);
    kb.row();
  } else if (ruleType === "pnl_target") {
    explain = `Trigger when this position's PnL hits a level (% of your ${usd(pp.margin)} margin).`;
    for (const v of [25, 50, 100]) {
      kb.text(`+${v}% (+${usd((pp.margin * v) / 100)})`, `grd:th:${ruleType}:${symbol}:+${v}`);
    }
    kb.row();
    for (const v of [10, 25, 50]) {
      kb.text(`−${v}% (−${usd((pp.margin * v) / 100)})`, `grd:th:${ruleType}:${symbol}:-${v}`);
    }
    kb.row();
  } else if (ruleType === "funding_drain") {
    explain = "Trigger when the daily funding you pay exceeds this amount.";
    for (const v of [5, 10, 25, 50]) kb.text(`$${v}/day`, `grd:th:${ruleType}:${symbol}:${v}`);
    kb.row();
  }

  kb.text("✏️ Custom", `grd:thc:${ruleType}:${symbol}`).row();
  kb.text("← Back", `protect:auto:${symbol}:${side}`);

  const msg = fmt`${t.icon} ${FormattedString.b(`${t.name} — ${symbol} ${side.toUpperCase()}`)}

${protectHeader(pp)}
━━━━━━━━━━━━━━━━━━━━━━━━━
${explain}`;
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function createScopedRule(
  ctx: BotContext,
  ruleType: GuardianRule["ruleType"],
  symbol: string,
  side: "long" | "short",
  threshold: string,
  direction: string,
  successHeader: string,
  successBody: string,
) {
  if (!ctx.user) return;
  await createRule({
    id: generateRuleId(),
    userId: ctx.user.id,
    ruleType,
    symbol,
    side,
    threshold,
    direction,
    action: "suggest",
  });
  const msg = fmt`✅ ${FormattedString.b(successHeader)}

${successBody}`;
  const kb = new InlineKeyboard()
    .text("🛡 Back to protect", `protect:${symbol}:${side}`)
    .text("📊 Positions", "nav:positions");
  await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
}

async function confirmScopedRule(
  ctx: BotContext,
  symbol: string,
  side: "long" | "short",
  header: string,
  body: string,
) {
  const msg = fmt`✅ ${FormattedString.b(header)}

${body}`;
  const kb = new InlineKeyboard()
    .text("🛡 Back to protect", `protect:${symbol}:${side}`)
    .text("📊 Positions", "nav:positions");
  await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
}

// Returns true when the pending input should be cleared (saved or terminal),
// false when the user should retry (recoverable validation failure).
export async function saveTrailRuleFromInput(
  ctx: BotContext,
  symbol: string,
  side: "long" | "short",
  trailPct: number,
): Promise<boolean> {
  if (!ctx.user) return true;
  const pp = await loadProtectPos(ctx, symbol, side);
  if (!pp) {
    await ctx.reply(`No open ${symbol} ${side.toUpperCase()} position.`);
    return true;
  }
  const stop = trailInitialStop(side, pp.mark, trailPct);
  if (!trailStopSafe(side, stop, pp.liq)) {
    await ctx.reply(
      `A ${trailPct}% trail would place the stop at ${fmtPrice(stop)}, past your liquidation ${fmtPrice(pp.liq)}. Enter a smaller distance:`,
    );
    return false;
  }
  await createRule({
    id: generateRuleId(),
    userId: ctx.user.id,
    ruleType: "trailing_stop",
    symbol,
    side,
    threshold: String(trailPct),
    direction: "trail",
    action: "suggest",
  });
  await confirmScopedRule(
    ctx,
    symbol,
    side,
    `Trailing stop on ${symbol}`,
    `${trailPct}% trail · stop starts ~${fmtPrice(stop)} and ratchets up.`,
  );
  return true;
}

export async function saveBreakevenRuleFromInput(
  ctx: BotContext,
  symbol: string,
  side: "long" | "short",
  armPct: number,
): Promise<boolean> {
  if (!ctx.user) return true;
  await createRule({
    id: generateRuleId(),
    userId: ctx.user.id,
    ruleType: "breakeven",
    symbol,
    side,
    threshold: String(armPct),
    direction: "above",
    action: "suggest",
  });
  await confirmScopedRule(
    ctx,
    symbol,
    side,
    `Breakeven on ${symbol}`,
    `When ${symbol} reaches +${armPct}%, your on-chain stop moves to entry.`,
  );
  return true;
}

export function registerGuardian(bot: Bot<BotContext>) {
  bot.command("guardian", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first.");
      return;
    }
    if (!(await requireActivation(ctx))) return;
    const arg = ctx.match?.trim().toLowerCase();
    if (arg === "off") {
      const count = await disableAllAutoActions(ctx.user.id);
      const msg = fmt`⏸ ${FormattedString.b("All auto-actions disabled.")}

${String(count)} rules downgraded to "Notify + suggest actions".
You'll still receive alerts for all active rules.`;
      await ctx.reply(msg.text, {
        entities: msg.entities,
        reply_markup: new InlineKeyboard().text("🛡 View rules", "grd:list"),
      });
      return;
    }
    await sendGuardianScreen(ctx);
  });

  // Activation gate for the whole Guardian surface (grd:* and protect:*).
  // Registered before the specific handlers so it runs first; passes through
  // via next() only when the user is activated.
  bot.callbackQuery(/^(grd|protect):/, async (ctx, next) => {
    if (ctx.user?.phoenixActivated) {
      await next();
      return;
    }
    await ctx.answerCallbackQuery();
    await requireActivation(ctx);
  });

  bot.callbackQuery("grd:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendGuardianScreen(ctx, true);
  });

  // ─── Protect hub (per-position) ──────────────────────────────────────
  bot.callbackQuery(/^protect:trail:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendTrailPicker(ctx, ctx.match[1], ctx.match[2] as "long" | "short");
  });

  bot.callbackQuery(/^protect:trailgo:([A-Z0-9]+):(long|short):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saving…");
    if (!ctx.user) return;
    const [symbol, side, pct] = [ctx.match[1], ctx.match[2] as "long" | "short", ctx.match[3]];
    try {
      await createScopedRule(
        ctx,
        "trailing_stop",
        symbol,
        side,
        pct,
        "trail",
        `Trailing stop on ${symbol}`,
        `${pct}% trail. Your on-chain stop now follows the price and ratchets up.`,
      );
    } catch (err) {
      await renderBotError(ctx, err, { action: "set trailing stop", edit: true });
    }
  });

  bot.callbackQuery(/^protect:be:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendBreakevenPicker(ctx, ctx.match[1], ctx.match[2] as "long" | "short");
  });

  bot.callbackQuery(/^protect:trailc:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const [symbol, side] = [ctx.match[1], ctx.match[2]];
    await ctx.editMessageText(`Enter a trail distance % for ${symbol} (e.g. 4):`);
    await setPending(ctx.from.id, `protect_trail:${symbol}:${side}`);
  });

  bot.callbackQuery(/^protect:bec:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const [symbol, side] = [ctx.match[1], ctx.match[2]];
    await ctx.editMessageText(`Enter the profit % to arm breakeven for ${symbol} (e.g. 25):`);
    await setPending(ctx.from.id, `protect_be:${symbol}:${side}`);
  });

  bot.callbackQuery(/^protect:bego:([A-Z0-9]+):(long|short):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saving…");
    if (!ctx.user) return;
    const [symbol, side, pct] = [ctx.match[1], ctx.match[2] as "long" | "short", ctx.match[3]];
    try {
      await createScopedRule(
        ctx,
        "breakeven",
        symbol,
        side,
        pct,
        "above",
        `Breakeven on ${symbol}`,
        `When ${symbol} reaches +${pct}%, your on-chain stop moves to entry.`,
      );
    } catch (err) {
      await renderBotError(ctx, err, { action: "set breakeven", edit: true });
    }
  });

  bot.callbackQuery(/^protect:auto:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendAutoTriggerPicker(ctx, ctx.match[1], ctx.match[2] as "long" | "short");
  });

  bot.callbackQuery(/^protect:trig:(\w+):([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendProtectThreshold(ctx, ctx.match[1], ctx.match[2], ctx.match[3] as "long" | "short");
  });

  bot.callbackQuery(/^protect:([A-Z0-9]+):(long|short)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendProtectHub(ctx, ctx.match[1], ctx.match[2] as "long" | "short");
  });

  bot.callbackQuery("grd:close_menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => undefined);
  });

  bot.callbackQuery("grd:preset", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendPresetScreen(ctx);
  });

  bot.callbackQuery(/^grd:presetgo:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Creating rules…");
    if (!ctx.user) return;
    try {
      await applyPreset(ctx, ctx.match[1]);
    } catch (err) {
      await renderBotError(ctx, err, { action: "preset", edit: true });
    }
  });

  bot.callbackQuery("grd:new", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendRuleTypePicker(ctx);
  });

  bot.callbackQuery(/^grd:type:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const ruleType = ctx.match[1];
    if (ruleType === "exposure_limit" || ruleType === "margin_ratio") {
      await sendThresholdPicker(ctx, ruleType, "_all");
    } else {
      await sendSymbolPicker(ctx, ruleType);
    }
  });

  bot.callbackQuery(/^grd:sym:(\w+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendThresholdPicker(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.callbackQuery(/^grd:th:(\w+):([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [ruleType, symbol, threshold] = [ctx.match[1], ctx.match[2], ctx.match[3]];
    await sendActionPicker(ctx, ruleType, symbol, threshold);
  });

  bot.callbackQuery(/^grd:th_back:(\w+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendThresholdPicker(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.callbackQuery(/^grd:thc:(\w+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const [ruleType, symbol] = [ctx.match[1], ctx.match[2]];
    const t = typeInfo(ruleType);
    const unit =
      ruleType === "funding_drain" || ruleType === "exposure_limit"
        ? "dollar amount"
        : "percentage";
    await ctx.editMessageText(`Enter a ${unit} for ${t.name}:`);
    await setPending(ctx.from.id, `grd_threshold:${ruleType}:${symbol}`);
  });

  bot.callbackQuery(/^grd:act:(\w+):([^:]+):([^:]+):(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [ruleType, symbol, threshold, action] = [
      ctx.match[1],
      ctx.match[2],
      ctx.match[3],
      ctx.match[4],
    ];

    if (action === "notify" || action === "suggest") {
      await sendConfirmScreen(ctx, ruleType, symbol, threshold, action, null);
    } else if (action === "auto_close") {
      await sendAutoConfirm(ctx, ruleType, symbol, threshold, action, null);
    } else if (action === "auto_reduce") {
      await sendReducePicker(ctx, ruleType, symbol, threshold);
    } else if (action === "auto_margin") {
      await sendMarginPicker(ctx, ruleType, symbol, threshold);
    }
  });

  bot.callbackQuery(/^grd:act_back:(\w+):([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendActionPicker(ctx, ctx.match[1], ctx.match[2], ctx.match[3]);
  });

  bot.callbackQuery(/^grd:autoparam:(\w+):([^:]+):([^:]+):(\w+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [ruleType, symbol, threshold, action, param] = [
      ctx.match[1],
      ctx.match[2],
      ctx.match[3],
      ctx.match[4],
      ctx.match[5],
    ];
    await sendAutoConfirm(ctx, ruleType, symbol, threshold, action, param);
  });

  bot.callbackQuery(/^grd:margincustom:(\w+):([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const [ruleType, symbol, threshold] = [ctx.match[1], ctx.match[2], ctx.match[3]];
    await ctx.editMessageText("Enter the margin amount in USDC (e.g. 150):");
    await setPending(ctx.from.id, `grd_margin_amt:${ruleType}:${symbol}:${threshold}`);
  });

  bot.callbackQuery(/^grd:save:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saving…");
    if (!ctx.user) return;

    const parts = ctx.match[1].split(":");
    const [ruleType, symbol, thresholdStr, action] = parts;
    const actionParam = parts[4] || null;

    if (action === "auto_margin" && symbol !== "_all" && isIsolatedOnly(symbol)) {
      await ctx.editMessageText(
        `⚠️ Auto-add-margin isn't supported for isolated markets like ${symbol} yet. Use auto-reduce or auto-close instead.`,
        { reply_markup: new InlineKeyboard().text("🛡 Guardian", "grd:list") },
      );
      return;
    }

    const direction = directionForType(ruleType, thresholdStr);
    const parsed = parseThreshold(thresholdStr);
    const thresholdVal = parsed?.value ?? Number(thresholdStr);

    try {
      await createRule({
        id: generateRuleId(),
        userId: ctx.user.id,
        ruleType: ruleType as GuardianRule["ruleType"],
        symbol: symbol === "_all" ? null : symbol,
        threshold: String(thresholdVal),
        direction: parsed?.direction ?? direction,
        action: action as GuardianRule["action"],
        actionParam: actionParam || null,
      });

      const t = typeInfo(ruleType);
      const msg = fmt`✅ ${FormattedString.b("Rule saved")}

${t.icon} ${FormattedString.b(`${t.name} — ${symbol === "_all" ? "All" : symbol}`)}
The bot is now watching 24/7.`;

      const kb = new InlineKeyboard()
        .text("🛡 All rules", "grd:list")
        .text("📊 Positions", "nav:positions");
      await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
    } catch (err) {
      await renderBotError(ctx, err, { action: "save rule", edit: true });
    }
  });

  bot.callbackQuery(/^grd:edit:([a-f0-9]{8})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendRuleDetail(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^grd:edit:th:([a-f0-9]{8})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const rules = await getUserRules(ctx.user.id);
    const rule = rules.find((r) => r.id === ctx.match[1]);
    if (!rule) return;
    await sendThresholdPicker(ctx, rule.ruleType, rule.symbol ?? "_all");
  });

  bot.callbackQuery(/^grd:edit:act:([a-f0-9]{8})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const rules = await getUserRules(ctx.user.id);
    const rule = rules.find((r) => r.id === ctx.match[1]);
    if (!rule) return;
    await sendActionPicker(ctx, rule.ruleType, rule.symbol ?? "_all", rule.threshold);
  });

  bot.callbackQuery(/^grd:toggle:([a-f0-9]{8})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await toggleRule(ctx.match[1], ctx.user.id);
    await sendRuleDetail(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^grd:rm:([a-f0-9]{8})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const rules = await getUserRules(ctx.user.id);
    const rule = rules.find((r) => r.id === ctx.match[1]);
    if (!rule) return;

    const t = typeInfo(rule.ruleType);
    const msg = fmt`🗑 ${FormattedString.b("Delete this rule?")}

${t.icon} ${t.name} — ${rule.symbol ?? "All"}

This can't be undone.`;

    const kb = new InlineKeyboard()
      .text("🗑 Yes, delete", `grd:rmgo:${rule.id}`)
      .text("← Keep it", `grd:edit:${rule.id}`);

    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^grd:rmgo:([a-f0-9]{8})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Deleted.");
    if (!ctx.user) return;
    await deleteRule(ctx.match[1], ctx.user.id);
    await sendGuardianScreen(ctx, true);
  });

  bot.callbackQuery("grd:rmall", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const msg = fmt`🗑 ${FormattedString.b("Remove all Guardian rules?")}

This deletes every rule on your account (per-position and account-wide).
On-chain stops you've already placed stay in place. This can't be undone.`;
    const kb = new InlineKeyboard()
      .text("🗑 Yes, remove all", "grd:rmallgo")
      .text("✕ Cancel", "grd:list");
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery("grd:rmallgo", async (ctx) => {
    await ctx.answerCallbackQuery("Removed.");
    if (!ctx.user) return;
    const count = await deleteAllRules(ctx.user.id);
    const msg = fmt`🗑 ${FormattedString.b(`Removed ${count} rule${count === 1 ? "" : "s"}.`)}`;
    const kb = new InlineKeyboard().text("🛡 Guardian", "grd:list");
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery("grd:killswitch", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;

    const rules = await getUserRules(ctx.user.id);
    const autoCount = rules.filter(
      (r) => r.action === "auto_close" || r.action === "auto_reduce" || r.action === "auto_margin",
    ).length;

    const msg = fmt`⏸ ${FormattedString.b("Disable All Auto-Actions?")}

This will downgrade all auto-execute rules to "Notify + suggest".
You'll still get alerts — but nothing will execute automatically.

Rules affected: ${String(autoCount)}`;

    const kb = new InlineKeyboard()
      .text("⏸ Disable auto-actions", "grd:killgo")
      .text("✕ Cancel", "grd:list");

    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery("grd:killgo", async (ctx) => {
    await ctx.answerCallbackQuery("Disabled.");
    if (!ctx.user) return;
    const count = await disableAllAutoActions(ctx.user.id);

    const msg = fmt`⏸ ${FormattedString.b("All auto-actions disabled.")}

${String(count)} rules downgraded to "Notify + suggest actions".`;

    const kb = new InlineKeyboard().text("🛡 View rules", "grd:list");
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  // ─── Alert action callbacks (from guardian notifications) ──────────
  bot.callbackQuery(/^grd:close:([A-Z0-9]+):(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side] = [ctx.match[1], ctx.match[2]];

    try {
      const state = await getTraderState(ctx.user.walletAddress);
      const pos = state.positions.find((p) => p.symbol === symbol && p.side === side);
      if (!pos) {
        await ctx.editMessageText("Position not found. It may have already been closed.");
        return;
      }

      const notional = Number(pos.size) * Number(pos.markPrice);
      const msg = fmt`⚠️ ${FormattedString.b(`Close ${symbol} ${side.toUpperCase()}?`)}

Size: ${pos.size} ${symbol} (~${FormattedString.code(money(notional))})
Mark: ${FormattedString.code(fmtPrice(Number(pos.markPrice)))}
Est. PnL: ${FormattedString.code(signedMoney(Number(pos.unrealizedPnl)))}`;

      const kb = new InlineKeyboard()
        .text("✅ Close now", `grd:closego:${symbol}:${side}`)
        .text("✕ Cancel", "nav:positions");
      await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
    } catch (err) {
      await renderBotError(ctx, err, { action: "close preview", edit: true });
    }
  });

  bot.callbackQuery(/^grd:closego:([A-Z0-9]+):(\w+)$/, async (ctx) => {
    if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id))) return;
    if (!(await checkOrderRateLimit(ctx))) return;
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const user = ctx.user;
    const [symbol, _side] = [ctx.match[1], ctx.match[2]];

    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !msgId) return;

    await ctx.editMessageText(CONFIRMING);

    void (async () => {
      try {
        const settings = await getSettings(user.id);
        const fee = getFeeConfig(settings.feeMode, settings.customFeeSol);
        const txSig = await closePosition(symbol, user.walletAddress, 1, fee);

        const body = fmt`${symbol} ${_side === "long" ? "Long" : "Short"} position closed.`;
        const msg = txSuccess({ header: "Position closed", body, signature: txSig });
        const kb = new InlineKeyboard()
          .text("📊 Positions", "nav:positions")
          .text("🛡 Guardian", "grd:list");
        await ctx.api.editMessageText(chatId, msgId, msg.text, {
          entities: msg.entities,
          reply_markup: kb,
          ...TX_MSG_OPTS,
        });
      } catch (err) {
        const { msg: errMsg } = txError(err, "Close position");
        const kb = new InlineKeyboard()
          .text(`🔴 Retry close ${symbol}`, `grd:close:${symbol}:${_side}`)
          .text("📊 Positions", "nav:positions");
        await ctx.api
          .editMessageText(chatId, msgId, errMsg.text, {
            entities: errMsg.entities,
            reply_markup: kb,
          })
          .catch(() => undefined);
      }
    })().catch((err) => logger.error({ err }, "grd:closego async error"));
  });

  bot.callbackQuery(/^grd:reduce:([A-Z0-9]+):(\w+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, side, pctStr] = [ctx.match[1], ctx.match[2], ctx.match[3]];

    const msg = fmt`⚠️ ${FormattedString.b(`Reduce ${pctStr}% of ${symbol} ${side.toUpperCase()}?`)}`;
    const kb = new InlineKeyboard()
      .text(`✅ Reduce ${pctStr}%`, `grd:reducego:${symbol}:${side}:${pctStr}`)
      .text("✕ Cancel", "nav:positions");
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^grd:reducego:([A-Z0-9]+):(\w+):(\d+)$/, async (ctx) => {
    if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id))) return;
    if (!(await checkOrderRateLimit(ctx))) return;
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const user = ctx.user;
    const [symbol, side, pctStr] = [ctx.match[1], ctx.match[2], ctx.match[3]];
    const fraction = Number(pctStr) / 100;

    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !msgId) return;

    await ctx.editMessageText(CONFIRMING);

    void (async () => {
      try {
        const settings = await getSettings(user.id);
        const fee = getFeeConfig(settings.feeMode, settings.customFeeSol);
        const txSig = await closePosition(symbol, user.walletAddress, fraction, fee);
        const body = fmt`Reduced ${FormattedString.b(`${pctStr}%`)} of ${symbol}.`;
        const msg = txSuccess({ header: "Position reduced", body, signature: txSig });
        const kb = new InlineKeyboard()
          .text("📊 Positions", "nav:positions")
          .text("🛡 Guardian", "grd:list");
        await ctx.api.editMessageText(chatId, msgId, msg.text, {
          entities: msg.entities,
          reply_markup: kb,
          ...TX_MSG_OPTS,
        });
      } catch (err) {
        const { msg: errMsg } = txError(err, "Reduce position");
        const kb = new InlineKeyboard()
          .text(`🟡 Retry reduce ${symbol}`, `grd:reduce:${symbol}:${side}:${pctStr}`)
          .text("📊 Positions", "nav:positions");
        await ctx.api
          .editMessageText(chatId, msgId, errMsg.text, {
            entities: errMsg.entities,
            reply_markup: kb,
          })
          .catch(() => undefined);
      }
    })().catch((err) => logger.error({ err }, "grd:reducego async error"));
  });

  bot.callbackQuery(/^grd:margin:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const [symbol, amount] = [ctx.match[1], ctx.match[2]];

    const msg = fmt`📥 ${FormattedString.b(`Add $${amount} margin to ${symbol}?`)}`;
    const kb = new InlineKeyboard()
      .text(`✅ Add $${amount}`, `grd:margingo:${symbol}:${amount}`)
      .text("✕ Cancel", "nav:positions");
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^grd:margingo:([A-Z0-9]+):(\d+)$/, async (ctx) => {
    if (!(await claimIdempotencyKey(ctx.from.id, ctx.callbackQuery.id))) return;
    if (!(await checkOrderRateLimit(ctx))) return;
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const user = ctx.user;
    const [symbol, amountStr] = [ctx.match[1], ctx.match[2]];
    const amount = Number(amountStr);

    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !msgId) return;

    await ctx.editMessageText(CONFIRMING);

    void (async () => {
      try {
        const settings = await getSettings(user.id);
        const fee = getFeeConfig(settings.feeMode, settings.customFeeSol);
        const txSig = await addMargin(symbol, user.walletAddress, amountStr, fee);
        const body = fmt`${FormattedString.b(`$${amount}`)} added to ${symbol}.`;
        const msg = txSuccess({ header: "Margin added", body, signature: txSig });
        const kb = new InlineKeyboard()
          .text("📊 Positions", "nav:positions")
          .text("🛡 Guardian", "grd:list");
        await ctx.api.editMessageText(chatId, msgId, msg.text, {
          entities: msg.entities,
          reply_markup: kb,
          ...TX_MSG_OPTS,
        });
      } catch (err) {
        const { msg: errMsg } = txError(err, "Add margin");
        const kb = new InlineKeyboard()
          .text(`📥 Retry $${amount}`, `grd:margin:${symbol}:${amountStr}`)
          .text("📊 Positions", "nav:positions");
        await ctx.api
          .editMessageText(chatId, msgId, errMsg.text, {
            entities: errMsg.entities,
            reply_markup: kb,
          })
          .catch(() => undefined);
      }
    })().catch((err) => logger.error({ err }, "grd:margingo async error"));
  });

  bot.callbackQuery(/^grd:snooze:([a-f0-9]{8}):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Snoozed.");
    if (!ctx.user) return;
    const [ruleId, minutes] = [ctx.match[1], Number(ctx.match[2])];
    await redis.set(`guardian:snooze:${ruleId}`, "1", "EX", minutes * 60);

    await ctx.editMessageText(`⏸ Snoozed for ${minutes} minutes. Alert will not fire until then.`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📊 Positions", callback_data: "nav:positions" },
            { text: "🛡 Guardian", callback_data: "grd:list" },
          ],
        ],
      },
    });
  });
}
