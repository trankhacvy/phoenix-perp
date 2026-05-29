import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COLORS, inter } from "../theme";
import { TF } from "../timing";
import { block, eased } from "../anim";
import { PhoneFrame, PhoneStage } from "../components/PhoneFrame";
import { ChatHeader } from "../components/ChatHeader";
import { BotBubble, UserBubble } from "../components/Bubbles";
import { InlineKeyboard } from "../components/Keyboard";
import { QuoteCard } from "../components/QuoteCard";
import { TxStatusPill } from "../components/TxStatusPill";
import { CaptionBand } from "../components/CaptionBand";

const ENTRY = 184.2;
const MARGIN = 100;
const LEV = 10;
const SIZE = 1000;
const LIQ = 167.3;

const Slot: React.FC<{ inAt: number; outAt?: number; children: React.ReactNode }> = ({
  inAt,
  outAt,
  children,
}) => {
  const frame = useCurrentFrame();
  const { opacity, transform } = block(frame, inAt, outAt);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, opacity, transform }}>
      {children}
    </div>
  );
};

const StepLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      color: COLORS.textLo,
      fontFamily: inter,
      fontSize: 27,
      fontWeight: 500,
      margin: "0 4px 14px",
    }}
  >
    {children}
  </div>
);

export const Trade: React.FC = () => {
  const frame = useCurrentFrame();

  // phone slides up + fades in
  const enter = eased(frame, 0, 26);

  // top conversation appears
  const convo = block(frame, TF.chatIn, undefined, 30);

  return (
    <AbsoluteFill>
      <PhoneStage opacity={enter} extraTransform={`translateY(${(1 - enter) * 140}px)`}>
        <PhoneFrame>
          <ChatHeader subtitle="bot · online" />
          {/* chat body */}
          <div style={{ flex: 1, position: "relative", padding: "28px 26px 30px" }}>
            {/* persistent top conversation */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 16,
                opacity: convo.opacity,
                transform: convo.transform,
              }}
            >
              <UserBubble text="/long SOL" />
              <BotBubble>
                <div>
                  SOL · <b style={{ color: COLORS.long }}>LONG</b>
                </div>
                <div style={{ color: COLORS.textLo, fontSize: 25, marginTop: 4 }}>
                  Available $2,480 · trading account
                </div>
              </BotBubble>
            </div>

            {/* active slot (cross-fading), bottom-anchored */}
            <div style={{ position: "absolute", left: 26, right: 26, bottom: 30, minHeight: 380 }}>
              <Slot inAt={TF.sizeStep} outAt={TF.levStep}>
                <StepLabel>How much margin?</StepLabel>
                <InlineKeyboard
                  rows={[
                    [
                      { label: "$25" },
                      { label: "$50" },
                      { label: "$100", tapFrame: TF.tapSize },
                      { label: "$250" },
                    ],
                    [{ label: "✏️ Custom" }],
                  ]}
                />
              </Slot>

              <Slot inAt={TF.levStep} outAt={TF.quoteIn}>
                <StepLabel>Leverage?</StepLabel>
                <InlineKeyboard
                  rows={[
                    [
                      { label: "2×" },
                      { label: "5×" },
                      { label: "10× ⭐", variant: "star", tapFrame: TF.tapLev },
                      { label: "20×" },
                      { label: "50×" },
                    ],
                  ]}
                />
              </Slot>

              <Slot inAt={TF.quoteIn} outAt={TF.confirming}>
                <QuoteCard
                  entry={ENTRY}
                  marginUsd={MARGIN}
                  sizeUsd={SIZE}
                  leverage={LEV}
                  slippagePct={0.5}
                  liq={LIQ}
                  rollStart={TF.quoteIn + 6}
                  confirmTapFrame={TF.tapConfirm}
                />
              </Slot>

              <Slot inAt={TF.confirming}>
                <TxStatusPill
                  confirmingAt={TF.confirming}
                  filledAt={TF.filled}
                  sizeUsd={SIZE}
                  leverage={LEV}
                  entry={ENTRY}
                />
              </Slot>
            </div>
          </div>
        </PhoneFrame>
      </PhoneStage>

      <CaptionBand
        captions={[
          { text: "Long SOL. One tap.", at: TF.chatIn + 6 },
          { text: "Set your size", at: TF.sizeStep + 8 },
          { text: "Pick leverage", at: TF.levStep + 8 },
          { text: "Check the quote", at: TF.quoteIn + 10 },
          { text: "Filled. On-chain.", at: TF.filled + 2, big: true },
        ]}
      />
    </AbsoluteFill>
  );
};
