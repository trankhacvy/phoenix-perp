import { useCurrentFrame } from "remotion";
import { COLORS, grotesk } from "../theme";
import { eased } from "../anim";

export type Caption = { text: string; at: number; big?: boolean };

/**
 * Kinetic caption. Shows the active caption (the last one whose `at` has
 * passed), word-by-word reveal. `captions` use LOCAL scene frames.
 *
 * `align="left"` (default) = big left-half headline for the landscape layout.
 * `align="bottom"` = centered lower band.
 */
export const CaptionBand: React.FC<{
  captions: Caption[];
  align?: "left" | "bottom";
}> = ({ captions, align = "left" }) => {
  const frame = useCurrentFrame();
  const active = [...captions].reverse().find((c) => frame >= c.at);
  if (!active) return null;
  const words = active.text.split(" ");

  const container: React.CSSProperties =
    align === "left"
      ? {
          position: "absolute",
          left: 130,
          top: 0,
          bottom: 0,
          width: 1080,
          display: "flex",
          flexWrap: "wrap",
          alignContent: "center",
          alignItems: "center",
          gap: 18,
          zIndex: 30,
        }
      : {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 70,
          display: "flex",
          justifyContent: "center",
          flexWrap: "wrap",
          gap: 16,
          padding: "0 80px",
          zIndex: 30,
        };

  const baseSize = align === "left" ? (active.big ? 104 : 78) : active.big ? 70 : 54;

  return (
    <div style={container}>
      {words.map((w, i) => {
        const wp = eased(frame, active.at + i * 3, 12);
        return (
          <span
            key={`${active.text}-${i}`}
            style={{
              fontFamily: grotesk,
              fontWeight: 700,
              fontSize: baseSize,
              color: COLORS.textHi,
              letterSpacing: -1.5,
              lineHeight: 1.05,
              opacity: wp,
              transform: `translateY(${(1 - wp) * 26}px)`,
              textShadow: "0 4px 30px rgba(0,0,0,0.6)",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};
