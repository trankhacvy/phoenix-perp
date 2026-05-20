import { InlineKeyboard } from "grammy";

export function sizeKeyboard() {
  return new InlineKeyboard()
    .text("25%", "size:25")
    .text("50%", "size:50")
    .text("75%", "size:75")
    .text("100%", "size:100");
}

// Leverage options are dynamically capped per market — caller must pass maxLeverage
export function leverageKeyboard(maxLeverage: number) {
  const options = [2, 5, 10, 25].filter((l) => l <= maxLeverage);
  const kb = new InlineKeyboard();
  for (const l of options) kb.text(`${l}x`, `leverage:${l}`);
  return kb;
}

export function confirmKeyboard(action: string) {
  return new InlineKeyboard()
    .text("✅ Confirm", `confirm:${action}`)
    .text("❌ Cancel", "cancel");
}
