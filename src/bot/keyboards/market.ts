import { InlineKeyboard } from "grammy";

export function marketActionKeyboard(symbol: string) {
  return new InlineKeyboard()
    .text("Long", `trade:long:${symbol}`)
    .text("Short", `trade:short:${symbol}`)
    .text("Alert", `alert:${symbol}`)
    .text("Price", `price:${symbol}`);
}
