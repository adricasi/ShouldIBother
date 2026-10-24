/**
 * The fixed choices of the simulation. They are part of the method, printed in the report and
 * hashed into the run fingerprint, so a changed choice can never silently resume an old run.
 */

import type { Band } from "../../domain/bands.js";
import type { BacktestChore } from "../../domain/outcomes.js";
import type { Dryer } from "../../domain/savings.js";

import type { Action } from "./types.js";

/**
 * A simulated household follows the odds: it bets on doing nothing when the band is "likely"
 * (70 %) or better, and does the chore otherwise. Same rule for the rule baseline and for Gemma.
 * [ASSUMPTION: the spec does not say how a band becomes a decision.]
 */
export const SKIP_FROM_BAND: Band = 3;

export function actionForBand(band: Band): Action {
  return band >= SKIP_FROM_BAND ? "skip" : "do_it";
}

/**
 * The backtest uses no household data (AC-018.4), so the dryer behind the line-dry savings is a
 * fixed, conservative assumption: the lowest figure in the catalogue.
 */
export const BACKTEST_DRYER: Dryer = "heat-pump";

/** The backtest keeps a model loaded 5 minutes after a call; the live app keeps it 24 h. */
export const BACKTEST_KEEP_ALIVE = "5m";

/** Fixed sampling seed of every Gemma call (NFR-012); temperature comes from `config/models.json`. */
export const BACKTEST_SEED = 20261024;

/** Day 0 of the "water every other day" routine: the first day of the series. */
const ROUTINE_ORIGIN_DATE = "2026-04-01";

function dayNumber(date: string): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${ROUTINE_ORIGIN_DATE}T00:00:00Z`)) / 86_400_000,
  );
}

function month(date: string): number {
  return Number(date.slice(5, 7));
}

/**
 * The fixed routine: the habit baseline (product.md, glossary). It never looks at a forecast.
 * Returns what the household does that day; "skip" means the routine leaves the chore undone.
 */
export function fixedRoutineAction(chore: BacktestChore, date: string): Action {
  switch (chore) {
    case "plants":
      // Water every other day: the days in between are skips.
      return dayNumber(date) % 2 === 0 ? "do_it" : "skip";
    case "laundry_line":
    case "laundry_tonight":
      // Tumble dry every load; bring the laundry in every evening.
      return "do_it";
    case "ac": {
      // AC every evening of the warm season, 1 Jun to 30 Sep.
      const m = month(date);
      return m >= 6 && m <= 9 ? "do_it" : "skip";
    }
    case "heater": {
      // Heater every day of the heating season, 1 Nov to 31 Mar.
      const m = month(date);
      return m >= 11 || m <= 3 ? "do_it" : "skip";
    }
  }
}

export const FIXED_ROUTINE_DESCRIPTION: Readonly<Record<BacktestChore, string>> = {
  plants: "water the pots every other day (even days from 1 Apr 2026); the days between are skips",
  laundry_line: "tumble dry every load (never line-dries, so never skips the dryer)",
  laundry_tonight: "brings the laundry in every evening (never leaves it out)",
  ac: "AC every evening from 1 Jun to 30 Sep; no AC the rest of the year (skips)",
  heater: "heater every day from 1 Nov to 31 Mar; no heater the rest of the year (skips)",
};

/**
 * Seasons in which the household's baseline would use the chore (month ranges, inclusive). The
 * spec gives none (AC-016.5 gates AC and heater by household data, which the backtest does not
 * use), so these are invented: the same dates as the fixed routine. Savings are credited only
 * inside them; a win outside is counted and reported apart.
 */
export const SAVINGS_SEASON_DESCRIPTION: Readonly<Partial<Record<BacktestChore, string>>> = {
  ac: "AC: 1 Jun to 30 Sep",
  heater: "heater: 1 Nov to 31 Mar",
};

export function inSavingsSeason(chore: BacktestChore, date: string): boolean {
  const m = month(date);
  switch (chore) {
    case "ac":
      return m >= 6 && m <= 9;
    case "heater":
      return m >= 11 || m <= 3;
    default:
      return true;
  }
}

/** The assumptions behind the figures that the spec does not give; printed in every report. */
export const ASSUMPTIONS: readonly string[] = [
  `Decision threshold: the household bets on doing nothing from the "likely" band (odds of 70 % or more) and does the chore otherwise; the spec does not say how a band becomes a decision.`,
  `Savings baseline: a household that does every chore every day it is in season (plants and laundry: every day; ${SAVINGS_SEASON_DESCRIPTION.ac}; ${SAVINGS_SEASON_DESCRIPTION.heater}); the season dates are invented because the spec gives none. A skip that worked outside the season saves nothing and is counted apart.`,
  `Savings are credited only on skips that worked, with the catalogue figures and a ${BACKTEST_DRYER} dryer (the lowest figure; no household data in the backtest). Time counts skipped steps only; net time subtracts 30 s per bet or do-it decision made in the app (the fixed routine uses no app).`,
  "Fixed routine: the definitions above are invented to match the examples in product.md (water every other day, tumble dry every load, AC on warm evenings).",
  "Calibration covers every day a strategy priced (not only the skips it took); a win of the outcome label counts as a success.",
];
