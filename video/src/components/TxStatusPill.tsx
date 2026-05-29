import { useCurrentFrame } from "remotion";
import { COLORS, inter } from "../theme";
import { eased, popped } from "../anim";
import { InlineKeyboard } from "./Keyboard";

/** Morphs from "confirming on-chain" to "filled" at `filledAt`. */
export const TxStatusPill: React.FC<{
  confirmingAt: number;
  filledAt: number;
  sizeUsd: number;
  leverage: number;
  entry: number;
}> = ({ confirmingAt, filledAt, sizeUsd, leverage, entry }) => {
  const frame = useCurrentFrame();
  const filled = frame >= filledAt;
  const progress = eased(frame, confirmingAt, filledAt - confirmingAt);
  const checkPop = popped(frame, filledAt, 16);

  return (
    <div
      style={{
        background: COLORS.bubbleIn,
        borderRadius: "4px 22px 22px 22px",
        padding: "22px 26px",
        fontFamily: inter,
        boxShadow: filled
          ? `0 0 0 1.5px ${COLORS.long}, 0 0 34px rgba(20,241,149,0.35)`
          : "0 10px 30px rgba(0,0,0,0.35)",
      }}
    >
      {!filled ? (
        <>
          <div style={{ color: COLORS.textHi, fontSize: 30, marginBottom: 16 }}>
            ⏳ Confirming on-chain… <span style={{ color: COLORS.textLo }}>(usually 2–5s)</span>
          </div>
          <div
            style={{
              height: 8,
              borderRadius: 6,
              background: "rgba(255,255,255,0.08)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${progress * 100}%`,
                background: `linear-gradient(90deg, ${COLORS.novaA}, ${COLORS.novaB})`,
              }}
            />
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
            <span
              style={{
                width: 52,
                height: 52,
                borderRadius: "50%",
                background: COLORS.long,
                color: "#04140C",
                fontSize: 32,
                fontWeight: 800,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transform: `scale(${checkPop})`,
                boxShadow: "0 0 22px rgba(20,241,149,0.6)",
              }}
            >
              ✓
            </span>
            <span style={{ color: COLORS.textHi, fontSize: 34, fontWeight: 700 }}>
              Long SOL filled
            </span>
          </div>
          <div
            style={{
              color: COLORS.textLo,
              fontSize: 28,
              marginLeft: 66,
              marginBottom: 18,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            Size ${sizeUsd.toLocaleString("en-US")} · {leverage}× · entry ${entry.toFixed(2)}
          </div>
          <InlineKeyboard
            rows={[
              [
                { label: "View on Solscan →", variant: "default" },
                { label: "🎯 Set TP / SL", variant: "star" },
              ],
            ]}
          />
        </>
      )}
    </div>
  );
};
