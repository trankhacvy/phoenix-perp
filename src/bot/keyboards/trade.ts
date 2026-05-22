import { InlineKeyboard } from "grammy";
import { usd } from "../lib/fmt.js";

export function leveragePickerKeyboard(
  side: "long" | "short",
  symbol: string,
  maxLeverage: number,
  defaultLeverage: number,
): InlineKeyboard {
  const options = [2, 3, 5, 10, 20, 50].filter((l) => l <= maxLeverage);
  const kb = new InlineKeyboard();
  let count = 0;
  for (const l of options) {
    const label = l === defaultLeverage ? `★${l}x` : `${l}x`;
    kb.text(label, `trade_lev:${side}:${symbol}:${l}`);
    count++;
    if (count % 3 === 0) kb.row();
  }
  kb.row().text("Custom", `trade_lev_custom:${side}:${symbol}`).text("✕ Cancel", "cancel");
  return kb;
}

export function sizePickerKeyboard(
  side: "long" | "short",
  symbol: string,
  lev: number,
  availableMargin: number,
): InlineKeyboard {
  const pcts = [10, 25, 50, 100];
  const kb = new InlineKeyboard();
  for (const p of pcts) {
    const amt = (availableMargin * p) / 100;
    kb.text(`${p}%  ${usd(amt)}`, `trade_size:${side}:${symbol}:${lev}:${amt.toFixed(2)}`).row();
  }
  kb.text("Custom amount", `trade_size_custom:${side}:${symbol}:${lev}`)
    .row()
    .text("← Back", `trade:${side}:${symbol}`)
    .text("✕ Cancel", "cancel");
  return kb;
}

export function confirmKeyboard(action: string): InlineKeyboard {
  return new InlineKeyboard().text("✅ Confirm", `confirm:${action}`).text("✕ Cancel", "cancel");
}
