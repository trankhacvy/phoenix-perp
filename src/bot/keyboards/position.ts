import { InlineKeyboard } from "grammy";

export function positionKeyboard(symbol: string) {
  return new InlineKeyboard()
    .text("Close 25%", `close:${symbol}:25`)
    .text("Close 50%", `close:${symbol}:50`)
    .row()
    .text("Close 75%", `close:${symbol}:75`)
    .text("Close 100%", `close:${symbol}:100`)
    .row()
    .text("Add Margin", `margin:${symbol}`)
    .text("Edit SL", `editsl:${symbol}`)
    .text("Edit TP", `edittp:${symbol}`);
}
