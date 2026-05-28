import { alertQueue } from "../../jobs/queues.js";
import { redis } from "../../lib/redis.js";
import type { CachedPosition } from "../../types/index.js";
import { esc, isAlertEnabled } from "./shared.js";

const TPSL_DEDUP_TTL = 60;

export async function evaluatePositionFlip(
  telegramId: string,
  userId: string,
  positions: CachedPosition[],
  prevPositions: CachedPosition[] | null,
) {
  if (!prevPositions) return;

  for (const pos of positions) {
    const prevPos = prevPositions.find((p) => p.symbol === pos.symbol);
    if (!prevPos || prevPos.side === pos.side) continue;

    if (!(await isAlertEnabled(userId, "tpsl_flip"))) continue;

    const dedupKey = `ws:dedup:${telegramId}:tpsl_flip:${pos.symbol}`;
    const isNew = await redis.set(dedupKey, "1", "EX", TPSL_DEDUP_TTL, "NX");
    if (!isNew) continue;

    const newSide = pos.side === "long" ? "LONG" : "SHORT";
    await alertQueue.add("tpsl-flip", {
      telegramId,
      type: "tpsl_flip",
      symbol: pos.symbol,
      message: [
        `🔄 <b>${esc(pos.symbol)} flipped to ${newSide}</b>`,
        "",
        `Your ${esc(pos.symbol)} position changed direction.`,
        "Previous TP/SL orders were cancelled.",
        "",
        `Set new TP/SL to protect your ${newSide.toLowerCase()} position.`,
      ].join("\n"),
      keyboard: [
        [
          { text: "🛑 Set SL", callback_data: `tpsl:open:sl:${pos.symbol}:${pos.side}` },
          { text: "🎯 Set TP", callback_data: `tpsl:open:tp:${pos.symbol}:${pos.side}` },
        ],
        [{ text: "📊 Positions", callback_data: "nav:positions" }],
      ],
    });
  }
}
