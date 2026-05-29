import { Img, staticFile } from "remotion";

const IconChip: React.FC<{ src: string; bg: string }> = ({ src, bg }) => (
  <div
    style={{
      width: 64,
      height: 64,
      borderRadius: "50%",
      overflow: "hidden",
      background: bg,
      boxShadow: "0 6px 18px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.08)",
    }}
  >
    <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  </div>
);

/** Persistent footer: Solana + Phoenix icons only. */
export const ChainLockup: React.FC<{ opacity?: number }> = ({ opacity = 1 }) => (
  <div
    style={{
      position: "absolute",
      left: 70,
      bottom: 54,
      display: "flex",
      justifyContent: "flex-start",
      alignItems: "center",
      gap: 20,
      opacity,
      zIndex: 25,
    }}
  >
    <IconChip src={staticFile("assets/solana.jpg")} bg="#000000" />
    <IconChip src={staticFile("assets/phoenix.png")} bg="#FFFFFF" />
  </div>
);
