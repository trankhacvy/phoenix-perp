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
  if (s.feeMode === "custom" && s.customFeeSol) return `Custom (${s.customFeeSol} SOL)`;
  const labels: Record<string, string> = { eco: "🌿 Eco", normal: "⚡ Normal", turbo: "🔥 Turbo" };
  return labels[s.feeMode] ?? "⚡ Normal";
}

function toggleIcon(v: boolean): string {
  return v ? "🟢" : "🔴";
}

function settingsMsg(s: Settings): FormattedString {
  const tpLabel = s.autoTpPct ? `+${s.autoTpPct}%` : "Off";
  const slLabel = s.autoSlPct ? `-${s.autoSlPct}%` : "Off";

  return fmt`⚙️ ${FormattedString.b("Settings")}

━━ ${FormattedString.b("Trade Defaults")} ━━
Slippage           ${FormattedString.code(`${s.slippageBps / 100}%`)}
Default Leverage   ${FormattedString.code(`${s.defaultLeverage}×`)}
Auto TP            ${FormattedString.code(tpLabel)}
Auto SL            ${FormattedString.code(slLabel)}

━━ ${FormattedString.b("Execution")} ━━
Priority Fee       ${FormattedString.code(feeLabel(s))}
Confirm Trades     ${toggleIcon(s.confirmTrades)}
Confirm Close      ${toggleIcon(s.confirmClose)}`;
}

function settingsKeyboard(s: Settings): InlineKeyboard {
  const feeIcon = (mode: string) => (s.feeMode === mode ? "★ " : "");

  return new InlineKeyboard()
    .text(`Slippage: ${s.slippageBps / 100}% ✏️`, "settings:slippage")
    .text(`Leverage: ${s.defaultLeverage}× ✏️`, "settings:leverage")
    .row()
    .text(`TP: ${s.autoTpPct ? `+${s.autoTpPct}%` : "Off"} ✏️`, "settings:auto_tp")
    .text(`SL: ${s.autoSlPct ? `-${s.autoSlPct}%` : "Off"} ✏️`, "settings:auto_sl")
    .row()
    .text(`${feeIcon("eco")}🌿 Eco`, "fee:eco")
    .text(`${feeIcon("normal")}⚡ Normal`, "fee:normal")
    .text(`${feeIcon("turbo")}🔥 Turbo`, "fee:turbo")
    .text("✏️", "fee:custom_prompt")
    .row()
    .text(`Confirm Trades: ${toggleIcon(s.confirmTrades)}`, "settings:toggle_confirm_trades")
    .text(`Confirm Close: ${toggleIcon(s.confirmClose)}`, "settings:toggle_confirm_close")
    .row()
    .text("🔔 Alerts", "al:main")
    .text("🛡 Guardian", "grd:list")
    .text("✕ Close", "settings:close");
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

  bot.callbackQuery("settings:close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Settings closed.");
  });

  // ── Slippage ────────────────────────────────────────────────────────────────

  bot.callbackQuery("settings:slippage", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const opt of SLIPPAGE_OPTIONS) {
      const star = opt.bps === s.slippageBps ? " ★" : "";
      kb.text(`${opt.label}${star}`, `slip:${opt.bps}`);
    }
    kb.row().text("← Back", "settings:back");
    await ctx.editMessageText("Select slippage tolerance:", { reply_markup: kb });
  });

  bot.callbackQuery(/^slip:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    await saveSettings(ctx.user.id, { slippageBps: Number(ctx.match[1]) });
    await sendSettingsScreen(ctx, true);
  });

  // ── Default leverage ────────────────────────────────────────────────────────

  bot.callbackQuery("settings:leverage", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const lev of LEVERAGE_OPTIONS) {
      const star = lev === s.defaultLeverage ? " ★" : "";
      kb.text(`${lev}×${star}`, `deflev:${lev}`);
    }
    kb.row().text("← Back", "settings:back");
    await ctx.editMessageText("Select default leverage:", { reply_markup: kb });
  });

  bot.callbackQuery(/^deflev:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Saved");
    if (!ctx.user) return;
    await saveSettings(ctx.user.id, { defaultLeverage: Number(ctx.match[1]) });
    await sendSettingsScreen(ctx, true);
  });

  // ── Auto TP ─────────────────────────────────────────────────────────────────

  bot.callbackQuery("settings:auto_tp", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const pct of AUTO_TP_OPTIONS) {
      const star = s.autoTpPct === pct ? " ★" : "";
      kb.text(`+${pct}%${star}`, `autotp:${pct}`);
    }
    kb.row()
      .text("✏️ Custom %", "autotp:custom_prompt")
      .row()
      .text("🗑 Off — no auto TP", "autotp:off")
      .row()
      .text("← Back", "settings:back");

    const msg = fmt`${FormattedString.b("Auto Take Profit")}

When set, TP is automatically placed after each trade opens.

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
    const kb = new InlineKeyboard().text("✕ Cancel", "cancel");
    await ctx.reply("Enter take profit percentage (e.g. 15 for +15%):", { reply_markup: kb });
  });

  // ── Auto SL ─────────────────────────────────────────────────────────────────

  bot.callbackQuery("settings:auto_sl", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const kb = new InlineKeyboard();
    for (const pct of AUTO_SL_OPTIONS) {
      const star = s.autoSlPct === pct ? " ★" : "";
      kb.text(`-${pct}%${star}`, `autosl:${pct}`);
    }
    kb.row()
      .text("✏️ Custom %", "autosl:custom_prompt")
      .row()
      .text("🗑 Off — no auto SL", "autosl:off")
      .row()
      .text("← Back", "settings:back");

    const msg = fmt`${FormattedString.b("Auto Stop Loss")}

When set, SL is automatically placed after each trade opens.

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
    const kb = new InlineKeyboard().text("✕ Cancel", "cancel");
    await ctx.reply("Enter stop loss percentage (e.g. 7 for -7%):", { reply_markup: kb });
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
    const kb = new InlineKeyboard().text("✕ Cancel", "cancel");
    const msg = fmt`Enter priority fee in SOL (e.g. ${FormattedString.code("0.003")}):

This sets both compute price and Jito tip.

Presets for reference:
  🌿 Eco    = 0.0006 SOL
  ⚡ Normal = 0.0015 SOL
  🔥 Turbo  = 0.0075 SOL`;
    await ctx.reply(msg.text, { entities: msg.entities, reply_markup: kb });
  });

  // ── Toggles ─────────────────────────────────────────────────────────────────

  bot.callbackQuery("settings:toggle_confirm_trades", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.user) return;
    const s = await getSettings(ctx.user.id);
    const next = await saveSettings(ctx.user.id, { confirmTrades: !s.confirmTrades });
    if (!next.confirmTrades) {
      await ctx.reply(
        "⚠️ Confirm Trades is now OFF. Trades will execute immediately after picking leverage.",
      );
    }
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
    const next = await saveSettings(ctx.user.id, { confirmClose: !s.confirmClose });
    if (!next.confirmClose) {
      await ctx.reply(
        "⚠️ Confirm Close is now OFF. Positions will close immediately when you tap a close button.",
      );
    }
    const msg = settingsMsg(next);
    await ctx.editMessageText(msg.text, {
      entities: msg.entities,
      reply_markup: settingsKeyboard(next),
    });
  });
}
