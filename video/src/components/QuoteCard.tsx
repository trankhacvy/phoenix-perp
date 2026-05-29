import { COLORS, inter } from "../theme";
import { RollNumber } from "./RollNumber";
import { InlineKeyboard } from "./Keyboard";

const Row: React.FC<{ label: string; children: React.ReactNode; hi?: boolean }> = ({
  label,
  children,
  hi,
}) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      padding: "11px 0",
    }}
  >
    <span style={{ color: COLORS.textLo, fontSize: 27 }}>{label}</span>
    <span
      style={{
        color: hi ? COLORS.textHi : COLORS.textHi,
        fontSize: 30,
        fontWeight: hi ? 700 : 600,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </span>
  </div>
);

const Divider = () => (
  <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "4px 0" }} />
);

/** The trade confirm quote (matches the bot's real confirm layout). */
export const QuoteCard: React.FC<{
  entry: number;
  marginUsd: number;
  sizeUsd: number;
  leverage: number;
  slippagePct: number;
  liq: number;
  rollStart: number; // local frame to start number rolls
  confirmTapFrame: number; // local frame of the Confirm tap
}> = ({ entry, marginUsd, sizeUsd, leverage, slippagePct, liq, rollStart, confirmTapFrame }) => (
  <div
    style={{
      background: COLORS.bubbleIn,
      borderRadius: "4px 22px 22px 22px",
      padding: "24px 26px 22px",
      fontFamily: inter,
      boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 6,
      }}
    >
      <span style={{ color: COLORS.textHi, fontSize: 34, fontWeight: 700 }}>
        SOL · <span style={{ color: COLORS.long }}>LONG</span>
      </span>
      <span
        style={{
          color: COLORS.textLo,
          fontSize: 24,
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 10,
          padding: "4px 12px",
        }}
      >
        Cross
      </span>
    </div>
    <Divider />
    <Row label="Entry">
      ~<RollNumber value={entry} start={rollStart} prefix="$" decimals={2} />
    </Row>
    <Row label="Margin">
      <RollNumber value={marginUsd} start={rollStart + 3} prefix="$" decimals={2} />
    </Row>
    <Row label="Position size" hi>
      <RollNumber value={sizeUsd} start={rollStart + 6} prefix="$" decimals={2} />
      <span style={{ color: COLORS.textLo, fontWeight: 500 }}> ({leverage}×)</span>
    </Row>
    <Row label="Max slippage">{slippagePct.toFixed(1)}%</Row>
    <Row label="Liq. price">
      <span style={{ color: COLORS.short }}>
        ~<RollNumber value={liq} start={rollStart + 9} prefix="$" decimals={2} />
      </span>
    </Row>
    <Divider />
    <div style={{ marginTop: 14 }}>
      <InlineKeyboard
        rows={[
          [
            { label: "✅ Confirm Long", variant: "confirm", tapFrame: confirmTapFrame, flex: 2 },
            { label: "✕ Cancel", variant: "cancel", flex: 1 },
          ],
        ]}
      />
    </div>
  </div>
);
