import { InlineKeyboard } from "grammy";

export type BracketStatus = "none" | "partial" | "full";

function bracketLabel(emoji: string, name: string, status: BracketStatus): string {
  if (status === "none") return `${emoji} Set ${name}`;
  if (status === "partial") return `${emoji} ${name} ⚠️`;
  return `${emoji} ${name} ✓`;
}

export function positionKeyboard(
  symbol: string,
  side: "long" | "short",
  tpStatus: BracketStatus = "none",
  slStatus: BracketStatus = "none",
): InlineKeyboard {
  const tpLabel = bracketLabel("🎯", "TP", tpStatus);
  const slLabel = bracketLabel("🛑", "SL", slStatus);
  return new InlineKeyboard()
    .text("Close 25%", `close:${symbol}:25:${side}`)
    .text("Close 50%", `close:${symbol}:50:${side}`)
    .text("Close 100%", `close:${symbol}:100:${side}`)
    .row()
    .text("Add Margin", `margin:${symbol}`)
    .text(tpLabel, `tpsl:open:tp:${symbol}:${side}`)
    .text(slLabel, `tpsl:open:sl:${symbol}:${side}`)
    .row()
    .text("🛡 Guard", "grd:type:liq_distance")
    .text("🔄 Refresh", `pos:refresh:${symbol}:${side}`)
    .text("◀ Back", "pos:list");
}
