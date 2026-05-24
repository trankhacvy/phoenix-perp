import type { Bot } from "grammy";
import { config } from "../../config/index.js";
import type { AlertButton } from "../../jobs/queues.js";
import type { BotContext } from "../../types/index.js";

const SAMPLE_ALERTS: { label: string; message: string; keyboard?: AlertButton[][] }[] = [
  {
    label: "1/9  Risk: At Risk",
    message: [
      "⚠️ <b>Account At Risk</b>",
      "",
      "Your margin is below initial requirement.",
      "Collateral: <code>$1,234.56</code>",
      "",
      "Deposit more or reduce positions.",
    ].join("\n"),
    keyboard: [
      [
        { text: "📊 Positions", callback_data: "nav:positions" },
        { text: "📥 Deposit", callback_data: "nav:deposit" },
      ],
    ],
  },
  {
    label: "2/9  Risk: Liquidatable",
    message: [
      "🚨 <b>LIQUIDATION WARNING</b>",
      "",
      "Your account can be liquidated NOW.",
      "Collateral: <code>$120.45</code>",
      "",
      "Act immediately — deposit or close positions.",
    ].join("\n"),
    keyboard: [
      [
        { text: "📊 Positions", callback_data: "nav:positions" },
        { text: "📥 Deposit", callback_data: "nav:deposit" },
      ],
    ],
  },
  {
    label: "3/9  Order Filled",
    message: [
      "✅ <b>Order Filled: SOL</b>",
      "",
      "LONG · 0.5 SOL @ $168.20",
      "Notional: $84.10  ·  Fee: $0.08",
    ].join("\n"),
    keyboard: [[{ text: "📊 View position", callback_data: "nav:positions" }]],
  },
  {
    label: "4/9  Position Reversed",
    message: [
      "🔄 <b>Position Reversed: SOL</b>",
      "",
      "Your SOL position flipped sides — existing TP/SL orders were cleared.",
      "Set new TP/SL to protect your position.",
    ].join("\n"),
    keyboard: [[{ text: "📊 Manage position", callback_data: "nav:positions" }]],
  },
  {
    label: "5/9  WS Connection Error",
    message: "⚠️ <b>Live alerts interrupted</b>\n\nLost connection to market feed. Reconnecting…",
    keyboard: [[{ text: "📊 Check positions", callback_data: "nav:positions" }]],
  },
  {
    label: "6/9  Monitor: Opened",
    message:
      "👁 <b>4xF2kJ8sPmVd7R9nQ3wLbT6yH1cX5zG8vN0mK9mR opened SOL</b>\nLONG · 0.5 SOL @ $168.20 · 10x",
    keyboard: [
      [
        { text: "🟢 Copy Long SOL", callback_data: "trade:long:SOL" },
        { text: "🔴 Counter Short SOL", callback_data: "trade:short:SOL" },
      ],
      [{ text: "📊 Trader", callback_data: "noop" }],
    ],
  },
  {
    label: "7/9  Monitor: Closed",
    message: "👁 <b>4xF2kJ8sPmVd7R9nQ3wLbT6yH1cX5zG8vN0mK9mR closed SOL</b>\nWas LONG · 0.5 SOL",
    keyboard: [[{ text: "📊 Trader", callback_data: "noop" }]],
  },
  {
    label: "8/9  Monitor: Flipped",
    message: "👁 <b>4xF2kJ8sPmVd7R9nQ3wLbT6yH1cX5zG8vN0mK9mR flipped SOL</b>\nLONG → SHORT",
    keyboard: [
      [
        { text: "🔴 Copy Short SOL", callback_data: "trade:short:SOL" },
        { text: "🟢 Counter Long SOL", callback_data: "trade:long:SOL" },
      ],
      [{ text: "📊 Trader", callback_data: "noop" }],
    ],
  },
  {
    label: "9/9  Price Alert",
    message: [
      "🔔 <b>Price Alert: SOL</b>",
      "",
      "Price reached <code>$150.00</code>",
      "(Your target: <code>$150</code>)",
    ].join("\n"),
    keyboard: [[{ text: "📊 SOL Market", callback_data: "market:detail:SOL:0" }]],
  },
];

export function registerStatus(bot: Bot<BotContext>) {
  if (config.NODE_ENV !== "development") return;

  bot.command("status", async (ctx) => {
    await ctx.reply("<b>Alert Message Preview</b>\n\nSending all 9 alert formats below ↓", {
      parse_mode: "HTML",
    });

    for (const alert of SAMPLE_ALERTS) {
      const text = `<i>— ${alert.label} —</i>\n\n${alert.message}`;
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: alert.keyboard ? { inline_keyboard: alert.keyboard } : undefined,
        link_preview_options: { is_disabled: true },
      });
    }
  });
}
