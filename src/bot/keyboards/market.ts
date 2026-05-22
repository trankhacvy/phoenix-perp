import { InlineKeyboard } from "grammy";

export function marketActionKeyboard(symbol: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🟢 Buy / Long", `trade:long:${symbol}`)
    .text("🔴 Sell / Short", `trade:short:${symbol}`)
    .row()
    .text("🔔 Price alert", `pricealert:${symbol}`)
    .text("📊 Info", `price:${symbol}`);
}
