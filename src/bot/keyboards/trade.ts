import { InlineKeyboard } from "grammy";
import { usd } from "../lib/fmt.js";

export function sizePickerKeyboard(
  side: "long" | "short",
  symbol: string,
  availableMargin: number,
): InlineKeyboard {
  const pcts = [10, 25, 50, 100];
  const kb = new InlineKeyboard();
  for (let i = 0; i < pcts.length; i++) {
    const p = pcts[i];
    const amt = Number.parseFloat(((availableMargin * p) / 100).toFixed(2));
    kb.text(`${usd(amt)}  (${p}%)`, `trade_size:${side}:${symbol}:${amt}`);
    if (i % 2 === 1) kb.row();
  }
  kb.text("Enter custom amount", `trade_size_custom:${side}:${symbol}`)
    .row()
    .text("← Back", `trade_sym:${side}:0`)
    .text("✕ Cancel", "cancel");
  return kb;
}

export function leveragePickerKeyboard(
  side: "long" | "short",
  symbol: string,
  sizeUsdc: number,
  maxLeverage: number,
  defaultLeverage: number,
): InlineKeyboard {
  const options = [2, 3, 5, 10, 20, 50].filter((l) => l <= maxLeverage);
  const kb = new InlineKeyboard();
  let count = 0;
  for (const l of options) {
    const positionSize = sizeUsdc * l;
    const star = l === defaultLeverage ? "★ " : "";
    kb.text(
      `${star}${l}× · ${usd(positionSize, 0, 0)}`,
      `trade_lev:${side}:${symbol}:${sizeUsdc}:${l}`,
    );
    count++;
    if (count % 2 === 0) kb.row();
  }
  kb.row()
    .text("Enter custom", `trade_lev_custom:${side}:${symbol}:${sizeUsdc}`)
    .row()
    .text("← Back", `trade:${side}:${symbol}`)
    .text("✕ Cancel", "cancel");
  return kb;
}

export function confirmKeyboard(action: string): InlineKeyboard {
  return new InlineKeyboard().text("✅ Confirm", `confirm:${action}`).text("✕ Cancel", "cancel");
}
