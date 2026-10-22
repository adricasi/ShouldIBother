import type { Flags } from "./features.js";

/** The flag that turns the PAID OUT stamp animation on (REQ-017); off, the static stamp stays. */
export const STAMP_FLAG = "stampAnimation";

/** True only while the server reports the flag as on; missing or unknown counts as off. */
export function isStampAnimated(flags: Flags): boolean {
  return flags[STAMP_FLAG] === true;
}

/**
 * The class list of the stamp. `stamp-animated` starts the landing animation in `styles.css`; the
 * reduced-motion choice (fade only, AC-017.2) is made there with `prefers-reduced-motion`.
 */
export function stampClassName(animated: boolean): string {
  return animated ? "stamp stamp-animated" : "stamp";
}
