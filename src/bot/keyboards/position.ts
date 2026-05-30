import { InlineKeyboard } from "grammy";

export type BracketStatus = "none" | "partial" | "full";

export function positionKeyboard(
  symbol: string,
  side: "long" | "short",
  tpStatus: BracketStatus = "none",
  slStatus: BracketStatus = "none",
): InlineKeyboard {
  const anySet = tpStatus !== "none" || slStatus !== "none";
  const protectLabel = anySet ? `🛡 Protect ${symbol} ✅` : `🛡 Protect ${symbol}`;
  return new InlineKeyboard()
    .text("Close 25%", `close:${symbol}:25:${side}`)
    .text("Close 50%", `close:${symbol}:50:${side}`)
    .text("Close 100%", `close:${symbol}:100:${side}`)
    .row()
    .text("💰 Add margin", `margin:${symbol}`)
    .text(protectLabel, `protect:${symbol}:${side}`)
    .row()
    .text("📸 Generate Card", `pos:card:${symbol}:${side}`)
    .row()
    .text("🔄 Refresh", `pos:refresh:${symbol}:${side}`)
    .text("← Back", "pos:list");
}
