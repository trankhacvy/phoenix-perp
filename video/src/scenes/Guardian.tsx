import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { COLORS, inter } from "../theme";
import { GF } from "../timing";
import { block, eased } from "../anim";
import { PhoneFrame, PhoneStage, PHONE } from "../components/PhoneFrame";
import { ChatHeader } from "../components/ChatHeader";
import { BotBubble } from "../components/Bubbles";
import { CaptionBand } from "../components/CaptionBand";

const Toggle: React.FC<{ toggleAt?: number }> = ({ toggleAt }) => {
  const frame = useCurrentFrame();
  const p = toggleAt == null ? 0 : eased(frame, toggleAt, 12);
  const bg = p > 0.02 ? `rgba(20,241,149,${0.2 + p * 0.8})` : "#2A3340";
  return (
    <div
      style={{
        width: 90,
        height: 50,
        borderRadius: 26,
        background: bg,
        position: "relative",
        flex: "0 0 auto",
        boxShadow: p > 0.5 ? "0 0 18px rgba(20,241,149,0.5)" : "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 6,
          left: 6,
          width: 38,
          height: 38,
          borderRadius: "50%",
          background: "#fff",
          transform: `translateX(${interpolate(p, [0, 1], [0, 40])}px)`,
        }}
      />
    </div>
  );
};

const RuleRow: React.FC<{
  icon: string;
  title: string;
  sub: string;
  toggleAt?: number;
  dim?: boolean;
}> = ({ icon, title, sub, toggleAt, dim }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 18,
      background: COLORS.bubbleIn,
      borderRadius: 20,
      padding: "20px 24px",
      opacity: dim ? 0.5 : 1,
      fontFamily: inter,
    }}
  >
    <span style={{ fontSize: 36 }}>{icon}</span>
    <div style={{ flex: 1 }}>
      <div style={{ color: COLORS.textHi, fontSize: 30, fontWeight: 600 }}>{title}</div>
      <div style={{ color: COLORS.textLo, fontSize: 24, marginTop: 2 }}>{sub}</div>
    </div>
    <Toggle toggleAt={toggleAt} />
  </div>
);

const Shield: React.FC = () => {
  const frame = useCurrentFrame();
  const draw = eased(frame, GF.shieldDraw, 40);
  const fill = eased(frame, GF.shieldFill, 26);
  const out = eased(frame, GF.alertIn - 6, 18);
  const opacity = (draw > 0 ? 1 : 0) * (1 - out);
  const scale = 0.8 + draw * 0.2;

  return (
    <div
      style={{
        position: "absolute",
        left: PHONE.width / 2,
        top: PHONE.height / 2 - 60,
        transform: `translate(-50%,-50%) scale(${scale})`,
        opacity,
        zIndex: 20,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -160,
          background:
            "radial-gradient(circle, rgba(20,241,149,0.35) 0%, rgba(5,5,15,0) 65%)",
          filter: "blur(4px)",
        }}
      />
      <svg viewBox="-60 -60 120 120" width={460} height={460} style={{ position: "relative" }}>
        <path
          d="M0,-46 L36,-32 V4 C36,30 18,44 0,52 C-18,44 -36,30 -36,4 V-32 Z"
          fill={`rgba(20,241,149,${fill * 0.16})`}
          stroke={COLORS.long}
          strokeWidth={3.5}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - draw}
          style={{ filter: "drop-shadow(0 0 14px rgba(20,241,149,0.7))" }}
        />
        <path
          d="M-16,2 L-4,16 L20,-14"
          fill="none"
          stroke={COLORS.long}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - fill}
        />
      </svg>
    </div>
  );
};

export const Guardian: React.FC = () => {
  const frame = useCurrentFrame();
  const fadeIn = eased(frame, 0, 8);
  const head = block(frame, GF.screenIn, undefined, 24);
  const rows = block(frame, GF.screenIn + 6, undefined, 28);
  const alert = block(frame, GF.alertIn, undefined, 36);

  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <PhoneStage>
        <PhoneFrame>
        <ChatHeader subtitle="bot · /guardian" />
        <div style={{ flex: 1, position: "relative", padding: "28px 26px 30px" }}>
          <div style={{ opacity: head.opacity, transform: head.transform, marginBottom: 18 }}>
            <BotBubble maxWidth={620}>
              <b>🛡 Guardian — auto-protection</b>
              <div style={{ color: COLORS.textLo, fontSize: 25, marginTop: 4 }}>
                Rules run on-chain, 24/7.
              </div>
            </BotBubble>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
              opacity: rows.opacity,
              transform: rows.transform,
            }}
          >
            <RuleRow
              icon="📉"
              title="Trailing stop · 5%"
              sub="Locks in gains as price climbs"
              toggleAt={GF.toggle1}
            />
            <RuleRow
              icon="🎯"
              title="Move to breakeven · +3%"
              sub="Risk-free once you're up 3%"
              toggleAt={GF.toggle2}
            />
            <RuleRow
              icon="🪙"
              title="Auto-reduce if margin < 20%"
              sub="Trims size before liquidation"
              dim
            />
          </div>

          {/* guardian fires by itself */}
          <div
            style={{
              position: "absolute",
              left: 26,
              right: 26,
              bottom: 30,
              opacity: alert.opacity,
              transform: alert.transform,
            }}
          >
            <BotBubble accent={COLORS.long} maxWidth={640}>
              <b>🛡 Guardian: stop moved to breakeven</b>
              <div style={{ color: COLORS.textLo, fontSize: 25, marginTop: 4 }}>
                SOL · LONG now risk-free · trailing at $186.40
              </div>
            </BotBubble>
          </div>
        </div>
        </PhoneFrame>
        <Shield />
      </PhoneStage>

      <CaptionBand
        captions={[
          { text: "Trailing stop.", at: GF.toggle1 + 4 },
          { text: "Breakeven. Auto.", at: GF.toggle2 + 4 },
          { text: "It guards while you sleep.", at: GF.alertIn + 4, big: true },
        ]}
      />
    </AbsoluteFill>
  );
};
