import { useCurrentFrame } from "remotion";
import { eased } from "../anim";
import { inter } from "../theme";

/** Count-up number with tabular figures. Rolls from 0 (or `from`) to `value`. */
export const RollNumber: React.FC<{
  value: number;
  start: number;
  dur?: number;
  from?: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  style?: React.CSSProperties;
}> = ({ value, start, dur = 22, from = 0, prefix = "", suffix = "", decimals = 2, style }) => {
  const frame = useCurrentFrame();
  const p = eased(frame, start, dur);
  const current = from + (value - from) * p;
  const text = current.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (
    <span style={{ fontFamily: inter, fontVariantNumeric: "tabular-nums", ...style }}>
      {prefix}
      {text}
      {suffix}
    </span>
  );
};
