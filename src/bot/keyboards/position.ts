import { InlineKeyboard } from "grammy";

export function positionKeyboard(symbol: string, side: "long" | "short"): InlineKeyboard {
  return new InlineKeyboard()
    .text("Close 25%", `close:${symbol}:25:${side}`)
    .text("Close 50%", `close:${symbol}:50:${side}`)
    .text("Close 100%", `close:${symbol}:100:${side}`)
    .row()
    .text("Add Margin", `margin:${symbol}`)
    .text("Set SL", `editsl:${symbol}:${side}`)
    .text("Set TP", `edittp:${symbol}:${side}`)
    .row()
    .text("🔄 Refresh", `pos:refresh:${symbol}:${side}`)
    .text("◀ Back", "pos:list");
}
