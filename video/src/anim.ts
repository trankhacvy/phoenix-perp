import { Easing, interpolate } from "remotion";

export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1); // crisp UI entrance
export const EASE_INOUT = Easing.bezier(0.45, 0, 0.55, 1); // editorial
export const EASE_POP = Easing.bezier(0.34, 1.56, 0.64, 1); // playful overshoot

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Eased 0->1 ramp over [start, start+dur]. */
export const eased = (frame: number, start: number, dur: number) =>
  interpolate(frame, [start, start + dur], [0, 1], { easing: EASE_OUT, ...clamp });

/** Overshoot 0->1 ramp for emphasis pops. */
export const popped = (frame: number, start: number, dur: number) =>
  interpolate(frame, [start, start + dur], [0, 1], { easing: EASE_POP, ...clamp });

/** Linear-ish 0->1. */
export const ramp = (frame: number, start: number, dur: number) =>
  interpolate(frame, [start, start + dur], [0, 1], { easing: EASE_INOUT, ...clamp });

/** Button tap: scale dips to 0.94 around tapFrame, then settles. */
export const tapScale = (frame: number, tapFrame: number) =>
  interpolate(frame, [tapFrame - 4, tapFrame, tapFrame + 7], [1, 0.94, 1], {
    easing: Easing.inOut(Easing.quad),
    ...clamp,
  });

/** Ripple radius 0->1 expanding after a tap (use for opacity-fading ring). */
export const ripple = (frame: number, tapFrame: number) =>
  interpolate(frame, [tapFrame, tapFrame + 18], [0, 1], { easing: EASE_OUT, ...clamp });

/**
 * Enter/exit block helper. Returns { opacity, transform } for a block that
 * slides up + fades in at `inAt`, and (optionally) slides up + fades out at `outAt`.
 */
export const block = (
  frame: number,
  inAt: number,
  outAt?: number,
  rise = 44,
): { opacity: number; transform: string } => {
  const inP = eased(frame, inAt, 14);
  const outP = outAt == null ? 0 : eased(frame, outAt, 12);
  const opacity = inP * (1 - outP);
  const ty = interpolate(inP, [0, 1], [rise, 0]) - interpolate(outP, [0, 1], [0, rise]);
  return { opacity, transform: `translateY(${ty}px)` };
};
