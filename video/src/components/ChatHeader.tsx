import { COLORS, inter, NOVA_GRADIENT } from "../theme";

export const ChatHeader: React.FC<{ subtitle?: string }> = ({ subtitle = "bot" }) => (
  <div
    style={{
      flex: "0 0 auto",
      height: 92,
      display: "flex",
      alignItems: "center",
      gap: 18,
      padding: "0 26px",
      background: "#17212B",
      borderBottom: "1px solid rgba(255,255,255,0.05)",
      fontFamily: inter,
    }}
  >
    <span style={{ color: "#6A7B8C", fontSize: 40, fontWeight: 300 }}>‹</span>
    <div
      style={{
        width: 60,
        height: 60,
        borderRadius: "50%",
        background: NOVA_GRADIENT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 30,
        boxShadow: "0 0 18px rgba(153,69,255,0.5)",
      }}
    >
      ⚡️
    </div>
    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
      <span style={{ color: COLORS.textHi, fontSize: 30, fontWeight: 600 }}>
        SuperNova
      </span>
      <span style={{ color: COLORS.long, fontSize: 22, fontWeight: 500 }}>{subtitle}</span>
    </div>
  </div>
);
