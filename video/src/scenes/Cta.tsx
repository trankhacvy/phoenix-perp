import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COLORS, grotesk, inter } from "../theme";
import { CF } from "../timing";
import { eased, popped } from "../anim";
import { Logo } from "../components/Logo";

export const Cta: React.FC = () => {
  const frame = useCurrentFrame();
  const ignite = eased(frame, CF.ignite, 26);
  const word = eased(frame, CF.wordmark, 22);
  const pill = popped(frame, CF.pill, 22);
  const tagline = eased(frame, CF.pill + 8, 20);
  const pulse = 1 + 0.025 * Math.sin((frame - CF.pill) / 6);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 30 }}>
        <Logo size={230} progress={ignite} />

        <div
          style={{
            opacity: word,
            transform: `translateY(${(1 - word) * 24}px)`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            style={{
              fontFamily: grotesk,
              fontWeight: 700,
              fontSize: 104,
              letterSpacing: -2,
              color: COLORS.textHi,
            }}
          >
            SuperNova
          </span>
          <span style={{ fontFamily: inter, fontSize: 38, fontWeight: 600, color: COLORS.textLo }}>
            <span style={{ color: COLORS.primary }}>@</span>supernovasol_bot
          </span>
        </div>

        <div
          style={{
            marginTop: 16,
            opacity: Math.max(0, Math.min(1, pill)),
            transform: `scale(${Math.min(pill, 1) * pulse})`,
            background: COLORS.primary,
            color: "#FFFFFF",
            fontFamily: inter,
            fontSize: 44,
            fontWeight: 700,
            padding: "26px 56px",
            borderRadius: 24,
            boxShadow: "0 0 50px rgba(255,42,42,0.5)",
          }}
        >
          Open Telegram → Trade now
        </div>

        <span
          style={{
            fontFamily: grotesk,
            fontWeight: 500,
            fontSize: 40,
            color: COLORS.textHi,
            opacity: tagline,
          }}
        >
          Perps, one tap away.
        </span>
      </div>
    </AbsoluteFill>
  );
};
