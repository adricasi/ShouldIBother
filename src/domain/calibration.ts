import { BANDS, nameOfBand, oddsOfBand, type Band, type BandTable } from "./bands.js";

/** A band with fewer settled bets than this is shown with its N and "too few to judge" (AC-020.3). */
export const MIN_BETS_PER_BAND = 5;

/** What the database counts for one band: settled do-nothing bets and how many of them won. */
export interface BandCount {
  readonly band: Band;
  readonly n: number;
  readonly wins: number;
}

/** One bar of a calibration chart: predicted odds against the share where doing nothing worked. */
export interface CalibrationBand {
  readonly band: Band;
  readonly name: string;
  /** The odds the band stands for, in percent. */
  readonly predicted_pct: number;
  readonly n: number;
  readonly wins: number;
  /** `wins / n` in percent, rounded to a whole number; null with no bets. */
  readonly actual_pct: number | null;
  /** True under `MIN_BETS_PER_BAND`: the figure is shown with its N but is not a verdict. */
  readonly too_few: boolean;
}

/**
 * A share in whole percent, halves up like every other figure (requirements.md, Fixed values).
 * Computed from the counts: `(23 / 40) * 100` is 57.4999... in floating point, 23 * 100 / 40 is 57.5.
 */
export function percentOf(part: number, whole: number): number {
  return Math.round((part * 100) / whole);
}

/**
 * Band calibration (AC-020.2, AC-020.3): all five bands, in order, each with its N. Every win
 * counts as a success, lucky wins included (AC-008.6); the caller decides which bets are counted.
 */
export function calibrationBands(
  table: BandTable,
  counts: readonly BandCount[],
): readonly CalibrationBand[] {
  return BANDS.map((band) => {
    const count = counts.find((entry) => entry.band === band);
    const n = count?.n ?? 0;
    const wins = count?.wins ?? 0;
    return {
      band,
      name: nameOfBand(table, band),
      predicted_pct: oddsOfBand(table, band),
      n,
      wins,
      actual_pct: n === 0 ? null : percentOf(wins, n),
      too_few: n < MIN_BETS_PER_BAND,
    };
  });
}
