/** How the user proved the outcome (REQ-008); sets the multiplier on a win. */
export type Evidence = "photo" | "tap" | "auto";

/** Verdicts of the judge for a do-nothing bet. */
export type DoNothingVerdict = "win" | "small_loss" | "normal_loss" | "harmful_loss";
/** Verdicts of the judge for a do-it decision. */
export type DoItVerdict = "weather_would_have" | "weather_would_not";
export type Verdict = DoNothingVerdict | DoItVerdict;

/** Evidence multiplier on a win: after photo x1.0, one tap or auto-settle x0.5. */
export const MULTIPLIER: Readonly<Record<Evidence, number>> = { photo: 1, tap: 0.5, auto: 0.5 };

export const LOSS_POINTS: Readonly<Record<Exclude<DoNothingVerdict, "win">, number>> = {
  small_loss: -25,
  normal_loss: -50,
  harmful_loss: -150,
};

export const DO_IT_POINTS: Readonly<Record<DoItVerdict, number>> = {
  weather_would_not: 5,
  weather_would_have: -10,
};

/** Advice followed: washing today on the planner's best drying day (AC-021.3, fixed values). */
export const ADVICE_FOLLOWED_POINTS = 5;

/** Rounds to the nearest integer, halves up (7.5 -> 8, 2.5 -> 3). */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** AC-009.1: a win pays (100 - odds) x multiplier, rounded half up. */
export function winPoints(odds: number, evidence: Evidence): number {
  return roundHalfUp((100 - odds) * MULTIPLIER[evidence]);
}

/**
 * Points of one settled bet (REQ-009). A loss costs the same whatever the evidence (AC-009.2);
 * a do-it decision scores +5 or -10 (AC-009.3). `odds` is the odds locked on the bet.
 */
export function pointsFor(input: {
  readonly kind: "do_nothing" | "do_it";
  readonly verdict: Verdict;
  readonly odds: number;
  readonly evidence: Evidence;
}): number {
  const { kind, verdict, odds, evidence } = input;
  if (kind === "do_it") {
    if (verdict === "weather_would_have" || verdict === "weather_would_not") {
      return DO_IT_POINTS[verdict];
    }
    throw new Error(`A do-it decision cannot have the verdict ${verdict}`);
  }
  if (verdict === "win") {
    return winPoints(odds, evidence);
  }
  if (verdict === "weather_would_have" || verdict === "weather_would_not") {
    throw new Error(`A do-nothing bet cannot have the verdict ${verdict}`);
  }
  return LOSS_POINTS[verdict];
}
