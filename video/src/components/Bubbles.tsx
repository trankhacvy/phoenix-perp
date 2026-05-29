import { COLORS, inter } from "../theme";

const Time: React.FC<{ t: string; check?: boolean; dark?: boolean }> = ({ t, check, dark }) => (
  <span
    style={{
      fontSize: 18,
      color: dark ? "rgba(255,255,255,0.55)" : COLORS.textLo,
      marginLeft: 12,
      alignSelf: "flex-end",
      whiteSpace: "nowrap",
    }}
  >
    {t}
    {check ? <span style={{ color: "#6FC2FF", marginLeft: 4 }}>✓✓</span> : null}
  </span>
);

export const BotBubble: React.FC<{
  children: React.ReactNode;
  time?: string;
  accent?: string;
  maxWidth?: number;
}> = ({ children, time = "9:41", accent, maxWidth = 560 }) => (
  <div style={{ display: "flex", justifyContent: "flex-start" }}>
    <div
      style={{
        maxWidth,
        background: COLORS.bubbleIn,
        borderRadius: "4px 22px 22px 22px",
        padding: "18px 22px",
        color: COLORS.textHi,
        fontFamily: inter,
        fontSize: 30,
        lineHeight: 1.34,
        boxShadow: accent
          ? `0 0 0 1.5px ${accent}, 0 0 26px ${accent}55`
          : "0 6px 18px rgba(0,0,0,0.25)",
        display: "flex",
        alignItems: "flex-end",
        gap: 4,
      }}
    >
      <div style={{ flex: 1 }}>{children}</div>
      <Time t={time} />
    </div>
  </div>
);

export const UserBubble: React.FC<{ text: string; time?: string }> = ({
  text,
  time = "9:41",
}) => (
  <div style={{ display: "flex", justifyContent: "flex-end" }}>
    <div
      style={{
        background: "#2B5278",
        borderRadius: "22px 4px 22px 22px",
        padding: "18px 22px",
        color: "#FFFFFF",
        fontFamily: inter,
        fontSize: 30,
        fontWeight: 500,
        display: "flex",
        alignItems: "flex-end",
        boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
      }}
    >
      <span>{text}</span>
      <Time t={time} check dark />
    </div>
  </div>
);
