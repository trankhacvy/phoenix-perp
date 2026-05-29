import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COLORS } from "../theme";

/** Persistent near-black canvas with a slow-breathing red glow. */
export const GlowBg: React.FC<{ intensity?: number }> = ({ intensity = 1 }) => {
  const frame = useCurrentFrame();
  const breathe = 0.5 + 0.5 * Math.sin(frame / 70);
  const glow = (0.35 + breathe * 0.25) * intensity;

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      {/* main red bloom, upper-center */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(60% 45% at 50% 32%, rgba(255,42,42,${0.34 * glow}) 0%, rgba(255,42,42,${0.10 * glow}) 40%, rgba(5,5,15,0) 70%)`,
        }}
      />
      {/* low warm kicker, bottom */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(50% 30% at 50% 92%, rgba(255,60,40,${0.10 * glow}) 0%, rgba(5,5,15,0) 60%)`,
        }}
      />
      {/* subtle vignette */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(75% 75% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};
