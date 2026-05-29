import { useCurrentFrame } from "remotion";
import { COLORS, inter } from "../theme";
import { ripple, tapScale } from "../anim";

export type Btn = {
  label: string;
  variant?: "default" | "confirm" | "cancel" | "star";
  tapFrame?: number; // local frame when this key is tapped (also marks it selected after)
  flex?: number;
};

const variantStyle = (v: Btn["variant"], selected: boolean) => {
  switch (v) {
    case "confirm":
      return { background: COLORS.long, color: "#04140C", fontWeight: 700 };
    case "cancel":
      return { background: COLORS.bubbleBtn, color: COLORS.short, fontWeight: 600 };
    case "star":
      return {
        background: selected ? "rgba(153,69,255,0.18)" : COLORS.bubbleBtn,
        color: COLORS.textHi,
        fontWeight: 600,
        boxShadow: `inset 0 0 0 2px ${COLORS.novaA}`,
      };
    default:
      return {
        background: selected ? "rgba(153,69,255,0.16)" : COLORS.bubbleBtn,
        color: COLORS.textHi,
        fontWeight: 500,
        boxShadow: selected ? `inset 0 0 0 2px ${COLORS.novaB}` : "none",
      };
  }
};

const KbButton: React.FC<{ btn: Btn }> = ({ btn }) => {
  const frame = useCurrentFrame();
  const tapped = btn.tapFrame != null;
  const selected = tapped && frame >= (btn.tapFrame as number);
  const scale = tapped ? tapScale(frame, btn.tapFrame as number) : 1;
  const rip = tapped ? ripple(frame, btn.tapFrame as number) : 0;
  const s = variantStyle(btn.variant, selected);

  return (
    <div
      style={{
        flex: btn.flex ?? 1,
        position: "relative",
        height: 76,
        borderRadius: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: inter,
        fontSize: 30,
        overflow: "hidden",
        transform: `scale(${scale})`,
        ...s,
      }}
    >
      {tapped && rip > 0 && rip < 1 ? (
        <span
          style={{
            position: "absolute",
            width: 240,
            height: 240,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.18)",
            transform: `scale(${rip})`,
            opacity: 1 - rip,
          }}
        />
      ) : null}
      <span style={{ position: "relative" }}>{btn.label}</span>
    </div>
  );
};

export const InlineKeyboard: React.FC<{ rows: Btn[][] }> = ({ rows }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    {rows.map((row, i) => (
      <div key={i} style={{ display: "flex", gap: 14 }}>
        {row.map((b, j) => (
          <KbButton key={j} btn={b} />
        ))}
      </div>
    ))}
  </div>
);
