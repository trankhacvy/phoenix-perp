import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { ALERTS, CTA, DURATION, GUARD, HOOK, TRADE } from "./timing";
import { GlowBg } from "./components/GlowBg";
import { ChainLockup } from "./components/ChainLockup";
import { Hook } from "./scenes/Hook";
import { Trade } from "./scenes/Trade";
import { Guardian } from "./scenes/Guardian";
import { Alerts } from "./scenes/Alerts";
import { Cta } from "./scenes/Cta";

export const SuperNovaTeaser: React.FC = () => {
  const frame = useCurrentFrame();

  // chain lockup: low opacity during feature scenes, resolves to full at CTA
  const lockupOpacity =
    frame < TRADE.start
      ? 0
      : frame < CTA.start
        ? 0.55
        : interpolate(frame, [CTA.start + 30, CTA.start + 60], [0.55, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });

  return (
    <AbsoluteFill>
      <Audio
        src={staticFile("audio/background-music.mp3")}
        volume={(f) =>
          interpolate(f, [0, 10, DURATION - 28, DURATION - 1], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        }
      />

      <GlowBg />

      <Sequence from={HOOK.start} durationInFrames={HOOK.len} layout="none">
        <Hook />
      </Sequence>

      <Sequence from={TRADE.start} durationInFrames={TRADE.len} layout="none">
        <Trade />
      </Sequence>

      <Sequence from={GUARD.start} durationInFrames={GUARD.len} layout="none">
        <Guardian />
      </Sequence>

      <Sequence from={ALERTS.start} durationInFrames={ALERTS.len} layout="none">
        <Alerts />
      </Sequence>

      <Sequence from={CTA.start} durationInFrames={CTA.len} layout="none">
        <Cta />
      </Sequence>

      {lockupOpacity > 0 ? <ChainLockup opacity={lockupOpacity} /> : null}
    </AbsoluteFill>
  );
};
