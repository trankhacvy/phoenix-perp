import { loadFont as loadGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

// Display / captions
export const grotesk = loadGrotesk("normal", {
  weights: ["500", "700"],
  subsets: ["latin"],
}).fontFamily;

// UI / body
export const inter = loadInter("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
}).fontFamily;

// Primary brand color is RED (matches the SuperNova logo). No gradients.
const PRIMARY = "#FF2A2A";

export const COLORS = {
  bg: "#05050F",
  surface: "#0E0E1A",
  tgChatBg: "#0E1621",
  bubbleIn: "#17212B",
  bubbleBtn: "#1C2733",
  bubbleBtnHi: "#243140",
  textHi: "#FFFFFF",
  textLo: "#8A97A3",
  primary: PRIMARY,
  long: "#14F195", // semantic: long / profit / confirm (kept for trade legibility)
  short: "#EA3943", // semantic: short / loss / liquidation risk
  // brand accents now all resolve to the primary red (was a purple→green nova gradient)
  novaA: PRIMARY,
  novaB: PRIMARY,
  phoenix: "#FF6B35",
  warn: "#F0B90B",
} as const;

// Kept name for compatibility — now a solid red (no gradient).
export const NOVA_GRADIENT = PRIMARY;
