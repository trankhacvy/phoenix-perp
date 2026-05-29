import { COLORS, inter } from "../theme";

/** iOS-style lock-screen notification card. */
export const PushNotif: React.FC<{
  icon: string;
  title: string;
  body: string;
  accent: string;
  copyButton?: boolean;
}> = ({ icon, title, body, accent, copyButton }) => (
  <div
    style={{
      width: 760,
      background: "rgba(28,32,42,0.82)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      borderRadius: 30,
      padding: "24px 26px",
      fontFamily: inter,
      boxShadow: `0 20px 60px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 1.5px ${accent}40`,
      display: "flex",
      gap: 20,
      alignItems: "flex-start",
    }}
  >
    <div
      style={{
        width: 70,
        height: 70,
        flex: "0 0 auto",
        borderRadius: 18,
        background: `${accent}22`,
        boxShadow: `inset 0 0 0 1.5px ${accent}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 38,
      }}
    >
      {icon}
    </div>
    <div style={{ flex: 1 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <span style={{ color: COLORS.textHi, fontSize: 30, fontWeight: 700 }}>{title}</span>
        <span style={{ color: COLORS.textLo, fontSize: 22 }}>now</span>
      </div>
      <div style={{ color: "rgba(255,255,255,0.82)", fontSize: 27, lineHeight: 1.3 }}>{body}</div>
      {copyButton ? (
        <div
          style={{
            marginTop: 16,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: accent,
            color: "#04140C",
            fontSize: 26,
            fontWeight: 700,
            padding: "10px 22px",
            borderRadius: 14,
          }}
        >
          Copy Long ↗
        </div>
      ) : null}
    </div>
  </div>
);
