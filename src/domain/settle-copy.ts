import type { Verdict } from "./points.js";

/**
 * The fixed words of a result, reviewed once and never generated: a loss is stated, never
 * shamed (design-handoff.md, "Never shame the user for doing a chore"; AC-010.2). The result
 * screen adds the points and Gemma's one-line reason next to these.
 */
export const VERDICT_TITLES: Readonly<Record<Verdict, string>> = {
  win: "You win",
  small_loss: "Small loss",
  normal_loss: "Loss",
  harmful_loss: "Harmful loss",
  weather_would_not: "Good call",
  weather_would_have: "The weather had it",
};

export const LOSS_COPY: Readonly<Record<Exclude<Verdict, "win">, string>> = {
  small_loss: "Close. It needed a small touch-up. The bet is closed and the next one starts fresh.",
  normal_loss:
    "The weather did not cover this one, so the chore was still on. It happens to every bookie.",
  harmful_loss:
    "That one cost something real. The slip is settled; Gemma will weigh it next time you bet.",
  weather_would_not: "You did the chore and the weather would not have covered it. Good call.",
  weather_would_have:
    "You did the chore and the weather would have covered it. A little spare effort, no harm done.",
};

/** The stamp printed on the receipt of a won bet (AC-010.1). */
export const PAID_OUT_STAMP = "PAID OUT";

/** Cash-out (REQ-022): the bet is folded before its settle time, so no verdict and no evidence. */
export const CASH_OUT_TITLE = "Cashed out";
export const CASH_OUT_EVIDENCE_TEXT = "Cashed out before the settle time: no evidence needed";
export const CASH_OUT_COPY =
  "You folded early. Minus 10 points, no savings counted, and the slip is closed.";
