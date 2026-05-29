// Single source of truth for all timing. Re-time the whole video from here.
export const FPS = 30;
export const DURATION = 900; // 30.0s

// --- Composition canvas (16:9 landscape) ---
export const WIDTH = 1920;
export const HEIGHT = 1080;

// --- Beat grid (124 BPM -> ~14.52 frames/beat). Snap keyframes to BEAT(n). ---
export const BPM = 124;
export const FPB = (60 / BPM) * FPS; // frames per beat ~14.52
export const BEAT = (n: number) => Math.round(n * FPB);
export const DROP = 400; // the fill hit (Scene 1 Beat F). Tune to your track.

// --- Scene boundaries (absolute start frame, length) ---
export const HOOK = { start: 0, len: 120 }; // 0.0 - 4.0s
export const TRADE = { start: 120, len: 340 }; // 4.0 - 15.3s
export const GUARD = { start: 460, len: 210 }; // 15.3 - 22.3s
export const ALERTS = { start: 670, len: 140 }; // 22.3 - 27.0s
export const CTA = { start: 810, len: 90 }; // 27.0 - 30.0s

// --- Trade-flow sub-beats (LOCAL frames inside the Trade sequence) ---
export const TF = {
  chatIn: 0, // phone + chat appear, /long typed
  sizeStep: 30, // size keyboard in
  tapSize: 75, // tap $100
  levStep: 90, // leverage keyboard in
  tapLev: 140, // tap 10x
  quoteIn: 150, // confirm card slides up
  tapConfirm: 210, // tap Confirm Long
  confirming: 230, // confirming pill
  filled: 280, // success (aligns ~DROP - TRADE.start)
} as const;

// --- Guardian sub-beats (LOCAL frames inside the Guardian sequence) ---
export const GF = {
  screenIn: 0,
  toggle1: 30,
  toggle2: 70,
  shieldDraw: 95,
  shieldFill: 135,
  alertIn: 165,
} as const;

// --- Alerts sub-beats (LOCAL frames inside the Alerts sequence) ---
export const AF = {
  dim: 0,
  notif1: 20,
  notif2: 52,
  notif3: 84,
  settle: 122,
} as const;

// --- CTA sub-beats (LOCAL frames inside the CTA sequence) ---
export const CF = {
  ignite: 0,
  wordmark: 30,
  pill: 48,
  lockup: 60,
} as const;
