import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COLORS, grotesk, inter } from "../theme";
import { eased } from "../anim";
import { Logo } from "../components/Logo";

const WORD = "SuperNova";

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();

  const ignite = eased(frame, 0, 45);
  const subtitle = eased(frame, 80, 24);

  // hand-off: zoom + fade out at the end (lead into Trade)
  const exit = eased(frame, 100, 20);
  const groupScale = 1 + exit * 0.35;
  const groupOpacity = 1 - exit;

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        opacity: groupOpacity,
        transform: `scale(${groupScale})`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Logo size={320} progress={ignite} />

        <div style={{ display: "flex", marginTop: 40 }}>
          {WORD.split("").map((ch, i) => {
            const p = eased(frame, 45 + i * 3, 16);
            return (
              <span
                key={i}
                style={{
                  fontFamily: grotesk,
                  fontWeight: 700,
                  fontSize: 110,
                  letterSpacing: -2,
                  color: COLORS.textHi,
                  opacity: p,
                  transform: `translateY(${(1 - p) * 30}px)`,
                }}
              >
                {ch}
              </span>
            );
          })}
        </div>

        <div
          style={{
            marginTop: 24,
            fontFamily: inter,
            fontSize: 40,
            fontWeight: 500,
            color: COLORS.textLo,
            letterSpacing: 0.5,
            opacity: subtitle,
            transform: `translateY(${(1 - subtitle) * 18}px)`,
          }}
        >
          Perps on Solana. <span style={{ color: COLORS.textHi }}>Inside Telegram.</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
