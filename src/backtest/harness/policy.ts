/**
 * The fixed choices of the simulation. They are part of the method, printed in the report and
 * hashed into the run fingerprint, so a changed choice can never silently resume an old run.
 */

import type { Band } from "../../domain/bands.js";
import type { OutcomeChore } from "../../domain/outcomes.js";
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
export function fixedRoutineAction(chore: OutcomeChore, date: string): Action {
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

export const FIXED_ROUTINE_DESCRIPTION: Readonly<Record<OutcomeChore, string>> = {
  plants: "water the pots every other day (even days from 1 Apr 2026); the days between are skips",
  laundry_line: "tumble dry every load (never line-dries, so never skips the dryer)",
  laundry_tonight: "brings the laundry in every evening (never leaves it out)",
  ac: "AC every evening from 1 Jun to 30 Sep; no AC the rest of the year (skips)",
  heater: "heater every day from 1 Nov to 31 Mar; no heater the rest of the year (skips)",
};

/** The simulated household does every chore every day unless a strategy skips it. */
export const SAVINGS_BASELINE =
  "Savings are counted on skips that worked (the weather delivered), against a household that would otherwise do every chore every day; the dryer is a " +
  `${BACKTEST_DRYER} dryer (no household data in the backtest). Time counts skipped steps only; net time subtracts 30 s per bet or do-it decision made in the app (the fixed routine uses no app).`;
