import { InlineKeyboard } from "grammy";

export function positionKeyboard(symbol: string, side: "long" | "short"): InlineKeyboard {
  return new InlineKeyboard()
    .text("Close 25%", `close:${symbol}:25:${side}`)
    .text("Close 50%", `close:${symbol}:50:${side}`)
    .row()
    .text("Close 75%", `close:${symbol}:75:${side}`)
    .text("Close all", `close:${symbol}:100:${side}`)
    .row()
    .text("Add margin", `margin:${symbol}`)
    .text("Edit SL", `editsl:${symbol}:${side}`)
    .text("Edit TP", `edittp:${symbol}:${side}`);
}
