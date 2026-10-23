/** The longest place label, counted in code points, not UTF-16 units (AC-026.3). */
export const MAX_PLACE_LABEL_CODE_POINTS = 40;

/**
 * Control characters (Unicode category Cc: newlines, tabs, escapes) and format characters (Cf:
 * bidirectional overrides, zero-width spaces and joiners, the byte-order mark), which can make a
 * label read differently from what it holds.
 */
const CONTROL = /[\p{Cc}\p{Cf}]/u;

export type PlaceLabelResult =
  | { readonly ok: true; readonly label: string | null }
  | { readonly ok: false; readonly problem: string };

/**
 * Checks the optional place label of onboarding (AC-026.3): trimmed, no control or invisible characters, at most
 * 40 code points. Blank means no label (`null`). It is free text shown in the weather board header
 * and nowhere else: it is not geocoded, and it never goes into an Open-Meteo request, a Gemma
 * prompt, a decision row, a log line or a dataset row.
 */
export function parsePlaceLabel(text: string | null | undefined): PlaceLabelResult {
  const label = (text ?? "").trim();
  if (label === "") {
    return { ok: true, label: null };
  }
  if (CONTROL.test(label)) {
    return { ok: false, problem: "The place name cannot contain control or invisible characters." };
  }
  if ([...label].length > MAX_PLACE_LABEL_CODE_POINTS) {
    return {
      ok: false,
      problem: `The place name is at most ${MAX_PLACE_LABEL_CODE_POINTS} characters.`,
    };
  }
  return { ok: true, label };
}
