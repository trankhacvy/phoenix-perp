import { COLORS } from "../theme";

// The phone is designed at this native (portrait) resolution. In landscape we
// render it at native size and scale the whole device down via <PhoneStage>.
export const PHONE = {
  width: 720,
  height: 1560,
  bezel: 14,
  radius: 60,
} as const;

// Landscape placement: phone scaled down, parked on the right half.
export const PHONE_SCALE = 0.6;
export const PHONE_LEFT = 1338; // 1920 - 720*0.6 - 150 right margin
export const PHONE_TOP = 72; // (1080 - 1560*0.6) / 2
// scaled footprint in canvas px
export const PHONE_W = PHONE.width * PHONE_SCALE;
export const PHONE_H = PHONE.height * PHONE_SCALE;

/**
 * Positions + scales the native-size phone (and any phone-relative overlays,
 * which should use native phone coordinates) into the landscape canvas.
 */
export const PhoneStage: React.FC<{
  children: React.ReactNode;
  extraTransform?: string;
  opacity?: number;
  filter?: string;
}> = ({ children, extraTransform = "", opacity = 1, filter }) => (
  <div
    style={{
      position: "absolute",
      left: PHONE_LEFT,
      top: PHONE_TOP,
      width: PHONE.width,
      height: PHONE.height,
      transformOrigin: "top left",
      transform: `${extraTransform} scale(${PHONE_SCALE})`,
      opacity,
      filter,
    }}
  >
    {children}
  </div>
);

const StatusBar: React.FC = () => (
  <div
    style={{
      height: 54,
      flex: "0 0 auto",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 34px",
      color: COLORS.textHi,
      fontSize: 24,
      fontWeight: 600,
      letterSpacing: 0.3,
    }}
  >
    <span>9:41</span>
    <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 18 }}>
      <span>5G</span>
      <span style={{ opacity: 0.9 }}>▮▮▮▯</span>
      <span
        style={{
          width: 34,
          height: 18,
          border: `2px solid ${COLORS.textHi}`,
          borderRadius: 5,
          position: "relative",
          display: "inline-block",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 2,
            right: 9,
            background: COLORS.long,
            borderRadius: 2,
          }}
        />
      </span>
    </div>
  </div>
);

/** The hero device. Children render inside the screen (below the status bar). */
export const PhoneFrame: React.FC<{
  children?: React.ReactNode;
  screenBg?: string;
  glow?: number;
}> = ({ children, screenBg = COLORS.tgChatBg, glow = 1 }) => {
  return (
    <div
      style={{
        position: "relative",
        width: PHONE.width,
        height: PHONE.height,
        borderRadius: PHONE.radius,
        padding: PHONE.bezel,
        background: "linear-gradient(160deg,#23232f 0%,#0b0b12 60%)",
        boxShadow: `0 40px 120px rgba(0,0,0,0.6), 0 0 ${90 * glow}px rgba(153,69,255,${0.28 * glow}), inset 0 0 2px rgba(255,255,255,0.25)`,
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: PHONE.radius - PHONE.bezel,
          overflow: "hidden",
          background: screenBg,
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        {/* notch */}
        <div
          style={{
            position: "absolute",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            width: 150,
            height: 30,
            background: "#000",
            borderRadius: 16,
            zIndex: 5,
          }}
        />
        <StatusBar />
        {children}
      </div>
    </div>
  );
};
