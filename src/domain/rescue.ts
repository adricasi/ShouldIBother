import type { Band } from "./bands.js";

/** AC-022.1: the alert fires when the rule band falls this many bands below the bet's band. */
export const RESCUE_BAND_DROP = 2;

/**
 * Whether the rule band for the remaining window has dropped far enough below the band the bet
 * was placed at (AC-022.1). Bands run 0 (very unlikely) to 4 (very likely), so a drop is a lower
 * number. A band that rose, or fell by one, raises nothing.
 */
export function bandDroppedEnough(betBand: Band, ruleBand: Band): boolean {
  return betBand - ruleBand >= RESCUE_BAND_DROP;
}
