import { InlineKeyboard } from "grammy";

export type BracketStatus = "none" | "partial" | "full";

export function positionKeyboard(
  symbol: string,
  side: "long" | "short",
  tpStatus: BracketStatus = "none",
  slStatus: BracketStatus = "none",
): InlineKeyboard {
  const anySet = tpStatus !== "none" || slStatus !== "none";
  const protectLabel = anySet ? "🛡 TP / SL" : "🛡 Protect (set TP/SL)";
  return new InlineKeyboard()
    .text("Close 25%", `close:${symbol}:25:${side}`)
    .text("Close 50%", `close:${symbol}:50:${side}`)
    .text("Close 100%", `close:${symbol}:100:${side}`)
    .row()
    .text("💰 Add margin", `margin:${symbol}`)
    .text(protectLabel, `tpsl:protect:${symbol}:${side}`)
    .row()
    .text("🛡 Guard", "grd:type:liq_distance")
    .text("🔄 Refresh", `pos:refresh:${symbol}:${side}`)
    .text("← Back", "pos:list");
}
