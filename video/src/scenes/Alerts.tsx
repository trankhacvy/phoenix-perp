import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { COLORS, inter } from "../theme";
import { AF } from "../timing";
import { eased, popped } from "../anim";
import { PhoneFrame, PhoneStage, PHONE_LEFT } from "../components/PhoneFrame";
import { ChatHeader } from "../components/ChatHeader";
import { PushNotif } from "../components/PushNotif";
import { CaptionBand } from "../components/CaptionBand";

const NOTIFS = [
  {
    at: AF.notif1,
    icon: "🚨",
    title: "Liquidation risk · SOL",
    body: "Cross margin hit at-risk tier. Add margin?",
    accent: COLORS.short,
  },
  {
    at: AF.notif2,
    icon: "🔼",
    title: "BTC crossed $72,000",
    body: "Your price alert just triggered.",
    accent: COLORS.novaA,
  },
  {
    at: AF.notif3,
    icon: "👁",
    title: "A trader you follow",
    body: "Opened LONG SOL · 20× · $48k size",
    accent: COLORS.long,
    copyButton: true,
  },
];

const FaintRow: React.FC<{ sym: string; side: string; pnl: string; up: boolean }> = ({
  sym,
  side,
  pnl,
  up,
}) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      background: COLORS.bubbleIn,
      borderRadius: 18,
      padding: "20px 24px",
      fontFamily: inter,
    }}
  >
    <div>
      <span style={{ color: COLORS.textHi, fontSize: 30, fontWeight: 600 }}>{sym}</span>
      <span style={{ color: up ? COLORS.long : COLORS.short, fontSize: 26, marginLeft: 12 }}>
        {side}
      </span>
    </div>
    <span
      style={{ color: up ? COLORS.long : COLORS.short, fontSize: 30, fontWeight: 600 }}
    >
      {pnl}
    </span>
  </div>
);

export const Alerts: React.FC = () => {
  const frame = useCurrentFrame();
  const fadeIn = eased(frame, 0, 8);
  const dim = eased(frame, AF.dim, 24);
  const blur = interpolate(dim, [0, 1], [0, 7]);

  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      {/* dimmed, blurred phone on the right */}
      <PhoneStage filter={`blur(${blur}px)`}>
        <PhoneFrame glow={0.5}>
          <ChatHeader subtitle="bot · positions" />
          <div
            style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14, padding: "28px 26px" }}
          >
            <FaintRow sym="SOL · LONG" side="10×" pnl="+$182.40" up />
            <FaintRow sym="ETH · SHORT" side="5×" pnl="+$54.10" up />
            <FaintRow sym="BTC · LONG" side="8×" pnl="-$22.80" up={false} />
          </div>
        </PhoneFrame>
      </PhoneStage>
      <AbsoluteFill style={{ background: `rgba(5,5,15,${dim * 0.62})` }} />

      {/* cascading notifications, stacked on the left */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: PHONE_LEFT,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 26,
        }}
      >
        {NOTIFS.map((n, i) => {
          const p = eased(frame, n.at, 16);
          const pop = popped(frame, n.at, 20);
          return (
            <div
              key={i}
              style={{
                opacity: p,
                transform: `translateY(${interpolate(p, [0, 1], [-55, 0])}px) scale(${interpolate(
                  pop,
                  [0, 1],
                  [0.92, 1],
                )})`,
              }}
            >
              <PushNotif
                icon={n.icon}
                title={n.title}
                body={n.body}
                accent={n.accent}
                copyButton={n.copyButton}
              />
            </div>
          );
        })}
      </div>

      <CaptionBand
        align="bottom"
        captions={[
          { text: "Risk alerts.", at: AF.notif1 + 4 },
          { text: "Price alerts.", at: AF.notif2 + 4 },
          { text: "Follow the sharks.", at: AF.notif3 + 6, big: true },
        ]}
      />
    </AbsoluteFill>
  );
};
