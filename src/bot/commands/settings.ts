import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { type Settings, getSettings, saveSettings } from "../../services/settings.js";
import type { BotContext } from "../../types/index.js";
import { clearPending, setPending } from "../lib/pending.js";

const SLIPPAGE_OPTIONS = [
  { label: "0.1%", bps: 10 },
  { label: "0.3%", bps: 30 },
  { label: "0.5%", bps: 50 },
  { label: "1.0%", bps: 100 },
  { label: "2.0%", bps: 200 },
];

const LEVERAGE_OPTIONS = [2, 5, 10, 25, 50];
const AUTO_TP_OPTIONS = [5, 10, 25, 50];
const AUTO_SL_OPTIONS = [2, 5, 10, 15];

function feeLabel(s: Settings): string {
  if (s.feeMode === "custom" && s.customFeeSol != null) return `Custom (${s.customFeeSol} SOL)`;
  const labels: Record<string, string> = { eco: "🌿 Eco", normal: "⚡ Normal", turbo: "🔥 Turbo" };
  return labels[s.feeMode] ?? "⚡ Normal";
}

function toggleIcon(v: boolean): string {
  return v ? "🟢" : "🔴";
}

function settingsMsg(s: Settings): FormattedString {
  const tpLabel = s.autoTpPct ? `+${s.autoTpPct}%` : "Off";
  const slLabel = s.autoSlPct ? `-${s.autoSlPct}%` : "Off";
  const onetap = !s.confirmTrades || !s.confirmClose;
  const warningLine = onetap
    ? fmt`\n\n⚠️ ${FormattedString.b("One-tap mode active")} — trades or closes execute without confirmation`
    : fmt``;

  return fmt`⚙️ ${FormattedString.b("Settings")}

━━ ${FormattedString.b("Trade Defaults")} ━━
Slippage           ${FormattedString.code(`${s.slippageBps / 100}%`)}
Default Leverage   ${FormattedString.code(`${s.defaultLeverage}×`)}
Auto TP            ${FormattedString.code(tpLabel)}
Auto SL            ${FormattedString.code(slLabel)}

━━ ${FormattedString.b("Execution")} ━━
Priority Fee       ${FormattedString.code(feeLabel(s))}
Confirm Trades     ${toggleIcon(s.confirmTrades)}
Confirm Close      ${toggleIcon(s.confirmClose)}${warningLine}`;
}

function settingsKeyboard(s: Settings): InlineKeyboard {
  const feeIcon = (mode: string) => (s.feeMode === mode ? "★ " : "");
  const customFeeActive = s.feeMode === "custom" && s.customFeeSol != null;
  const customFeeLabel = customFeeActive ? `★ ✏️ ${s.customFeeSol} SOL` : "✏️ Custom fee";

  return new InlineKeyboard()
    .text(`Slippage: ${s.slippageBps / 100}% ✏️`, "settings:slippage")
    .text(`Leverage: ${s.defaultLeverage}× ✏️`, "settings:leverage")
    .row()
    .text(`Auto TP: ${s.autoTpPct ? `+${s.autoTpPct}%` : "Off"} ✏️`, "settings:auto_tp")
    .text(`Auto SL: ${s.autoSlPct ? `-${s.autoSlPct}%` : "Off"} ✏️`, "settings:auto_sl")
    .row()
    .text(`${feeIcon("eco")}🌿 Eco`, "fee:eco")
    .text(`${feeIcon("normal")}⚡ Normal`, "fee:normal")
    .text(`${feeIcon("turbo")}🔥 Turbo`, "fee:turbo")
    .row()
    .text(customFeeLabel, "fee:custom_prompt")
    .row()
    .text(`Confirm Trades: ${toggleIcon(s.confirmTrades)}`, "settings:toggle_confirm_trades")
    .text(`Confirm Close: ${toggleIcon(s.confirmClose)}`, "settings:toggle_confirm_close")
    .row()
    .text("🔔 Alerts", "al:main")
    .text("🛡 Guardian", "grd:list");
}

async function sendSettingsScreen(ctx: BotContext, edit = false): Promise<void> {
  if (!ctx.user) return;
  const s = await getSettings(ctx.user.id);
  const msg = settingsMsg(s);
  const opts = { entities: msg.entities, reply_markup: settingsKeyboard(s) };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(msg.text, opts);
  } else {
    await ctx.reply(msg.text, opts);
  }
}

export function registerSettings(bot: Bot<BotContext>) {
  bot.command("settings", async (ctx) => {
    if (!ctx.user) {
      await ctx.reply("Please run /start first to set up your account.");
      return;
    }
    await sendSettingsScreen(ctx);
  });

  bot.callbackQuery("settings:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendSettingsScreen(ctx, true);
  });

  bot.callbackQuery("settings:open", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    await sendSettingsScreen(ctx, false);
  });

  bot.callbackQuery("settings:cancel_input", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    await clearPending(ctx.from.id);
    await sendSettingsScreen(ctx, true);
  });

  // ── Slippage ────────────────────────────────────────────────────────────────

  bot.callbackQuery("settings:slippage", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const opt of SLIPPAGE_OPTIONS) {
      const star = opt.bps === s.slippageBps ? "★ " : "";
      kb.text(`${star}${opt.label}`, `slip:${opt.bps}`);
    }
    kb.row().text("✏️ Custom %", "slip:custom_prompt").row().text("← Back", "settings:back");
    const msg = fmt`${FormattedString.b("Slippage Tolerance")}

Max price deviation accepted on entry and exit.
Too tight = frequent tx failures on volatile pairs.
Too wide = worse fill price.

Current: ${FormattedString.code(`${s.slippageBps / 100}%`)}`;
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^slip:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    await saveSettings(ctx.user.id, { slippageBps: Number(ctx.match[1]) });
    await sendSettingsScreen(ctx, true);
  });

  bot.callbackQuery("slip:custom_prompt", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, "settings_custom_slip");
    const kb = new InlineKeyboard().text("← Back", "settings:cancel_input");
    const msg = fmt`${FormattedString.b("Custom Slippage")}

Enter slippage % (Range: 0.01–5.00%)
e.g. ${FormattedString.code("0.75")} for 0.75%

Low values may cause tx failures on fast-moving markets.`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  // ── Default leverage ────────────────────────────────────────────────────────

  bot.callbackQuery("settings:leverage", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const lev of LEVERAGE_OPTIONS) {
      const star = lev === s.defaultLeverage ? "★ " : "";
      kb.text(`${star}${lev}×`, `deflev:${lev}`);
    }
    kb.row()
      .text("✏️ Custom (1–100×)", "deflev:custom_prompt")
      .row()
      .text("← Back", "settings:back");
    const msg = fmt`${FormattedString.b("Default Leverage")}

Pre-fills leverage when you open a trade.
You can still change it per-trade — this is just your starting point.

Current: ${FormattedString.code(`${s.defaultLeverage}×`)}`;
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^deflev:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    await saveSettings(ctx.user.id, { defaultLeverage: Number(ctx.match[1]) });
    await sendSettingsScreen(ctx, true);
  });

  bot.callbackQuery("deflev:custom_prompt", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, "settings_custom_lev");
    const kb = new InlineKeyboard().text("← Back", "settings:cancel_input");
    const msg = fmt`${FormattedString.b("Custom Default Leverage")}

Enter leverage (Range: 1–100×)
e.g. ${FormattedString.code("3")} for 3×

Pre-fills your leverage when opening trades. Changeable per-trade.`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  // ── Auto TP ─────────────────────────────────────────────────────────────────

  bot.callbackQuery("settings:auto_tp", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const pct of AUTO_TP_OPTIONS) {
      const star = s.autoTpPct === pct ? "★ " : "";
      kb.text(`${star}+${pct}%`, `autotp:${pct}`);
    }
    kb.row()
      .text("✏️ Custom %", "autotp:custom_prompt")
      .row()
      .text("🚫 Turn Off", "autotp:off")
      .row()
      .text("← Back", "settings:back");
    const msg = fmt`${FormattedString.b("Auto Take Profit")}

Automatically places a TP order after each trade opens.
Closes your ${FormattedString.b("full position")} when unrealized PnL hits the target.

• Applies to all markets
• Closes 100% of position size
• Override anytime via /positions

Current: ${FormattedString.code(s.autoTpPct ? `+${s.autoTpPct}%` : "Off")}`;
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^autotp:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    await saveSettings(ctx.user.id, { autoTpPct: Number(ctx.match[1]) });
    await sendSettingsScreen(ctx, true);
  });

  bot.callbackQuery("autotp:off", async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    await saveSettings(ctx.user.id, { autoTpPct: null });
    await sendSettingsScreen(ctx, true);
  });

  bot.callbackQuery("autotp:custom_prompt", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, "settings_auto_tp");
    const kb = new InlineKeyboard().text("← Back", "settings:cancel_input");
    const msg = fmt`${FormattedString.b("Auto TP — Custom %")}

Enter the profit % at which to auto-close your position.
Range: 1–500%

e.g. ${FormattedString.code("15")} to close at +15% unrealized PnL`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  // ── Auto SL ─────────────────────────────────────────────────────────────────

  bot.callbackQuery("settings:auto_sl", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const pct of AUTO_SL_OPTIONS) {
      const star = s.autoSlPct === pct ? "★ " : "";
      kb.text(`${star}-${pct}%`, `autosl:${pct}`);
    }
    kb.row()
      .text("✏️ Custom %", "autosl:custom_prompt")
      .row()
      .text("🚫 Turn Off", "autosl:off")
      .row()
      .text("← Back", "settings:back");
    const msg = fmt`${FormattedString.b("Auto Stop Loss")}

Automatically places an SL order after each trade opens.
Closes your ${FormattedString.b("full position")} when unrealized loss hits the limit.

• Applies to all markets
• Closes 100% of position size
• Does not replace liquidation — it's an early exit

Current: ${FormattedString.code(s.autoSlPct ? `-${s.autoSlPct}%` : "Off")}`;
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery(/^autosl:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    await saveSettings(ctx.user.id, { autoSlPct: Number(ctx.match[1]) });
    await sendSettingsScreen(ctx, true);
  });

  bot.callbackQuery("autosl:off", async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    await saveSettings(ctx.user.id, { autoSlPct: null });
    await sendSettingsScreen(ctx, true);
  });

  bot.callbackQuery("autosl:custom_prompt", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, "settings_auto_sl");
    const kb = new InlineKeyboard().text("← Back", "settings:cancel_input");
    const msg = fmt`${FormattedString.b("Auto SL — Custom %")}

Enter the max loss % you'll accept before auto-closing.
Range: 1–100%

e.g. ${FormattedString.code("8")} to close at -8% unrealized PnL`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  // ── Priority fee ────────────────────────────────────────────────────────────

  bot.callbackQuery(/^fee:(eco|normal|turbo)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    const mode = ctx.match[1] as "eco" | "normal" | "turbo";
    await saveSettings(ctx.user.id, { feeMode: mode });
    await sendSettingsScreen(ctx, true);
  });

  bot.callbackQuery("fee:custom_prompt", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user || !ctx.from) return;
    await clearPending(ctx.from.id);
    await setPending(ctx.from.id, "settings_custom_fee");
    const kb = new InlineKeyboard().text("← Back", "settings:cancel_input");
    const msg = fmt`${FormattedString.b("Custom Priority Fee")}

Sets the Jito tip + compute price for your transactions.
Higher fee = faster inclusion during network congestion.

Presets for reference:
  🌿 Eco    = 0.0006 SOL
  ⚡ Normal = 0.0015 SOL  ${FormattedString.i("(recommended)")}
  🔥 Turbo  = 0.0075 SOL

Enter fee in SOL (Range: 0.0001–0.01 SOL)
Values above 0.005 SOL are rarely needed.`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  // ── Toggles ─────────────────────────────────────────────────────────────────

  bot.callbackQuery("settings:toggle_confirm_trades", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    if (!s.confirmTrades) {
      const next = await saveSettings(ctx.user.id, { confirmTrades: true });
      const msg = settingsMsg(next);
      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        reply_markup: settingsKeyboard(next),
      });
      return;
    }
    const kb = new InlineKeyboard()
      .text("✅ Yes, disable confirmation", "settings:confirm_trades_off")
      .row()
      .text("◀ Keep it ON (recommended)", "settings:back");
    const msg = fmt`⚠️ ${FormattedString.b("Disable Trade Confirmation?")}

Trades will execute at market the instant you select leverage — using the size you entered. No review screen, no going back.

Are you sure?`;
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery("settings:confirm_trades_off", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const next = await saveSettings(ctx.user.id, { confirmTrades: false });
    const msg = settingsMsg(next);
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: settingsKeyboard(next),
    });
  });

  bot.callbackQuery("settings:toggle_confirm_close", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    if (!s.confirmClose) {
      const next = await saveSettings(ctx.user.id, { confirmClose: true });
      const msg = settingsMsg(next);
      await ctx.editMessageText(msg.text, {
        entities: msg.entities,
        reply_markup: settingsKeyboard(next),
      });
      return;
    }
    const kb = new InlineKeyboard()
      .text("✅ Yes, disable close confirmation", "settings:confirm_close_off")
      .row()
      .text("◀ Keep it ON (recommended)", "settings:back");
    const msg = fmt`⚠️ ${FormattedString.b("Disable Close Confirmation?")}

/positions close buttons will execute at market price immediately — no review step.

Are you sure?`;
    await ctx.editMessageText(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  bot.callbackQuery("settings:confirm_close_off", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const next = await saveSettings(ctx.user.id, { confirmClose: false });
    const msg = settingsMsg(next);
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: settingsKeyboard(next),
    });
  });
}
