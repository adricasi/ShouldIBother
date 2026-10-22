import type { Band } from "../bands.js";
import type { ForecastHour } from "../weather.js";

import type { RulesConfig } from "./schema.js";
import { allValues, coveredHours, roundTo } from "./window.js";

/** What the "skip the heater" rule saw between 08:00 and 22:00. */
export interface HeaterFacts {
  readonly dayMaxC: number;
  readonly sunshineHours: number;
}

export function heaterFacts(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
): HeaterFacts | null {
  const hours = coveredHours(forecast, fromMs, toMs);
  if (hours === null) {
    return null;
  }
  const temperature = allValues(hours, "temperatureC");
  const sunshine = allValues(hours, "sunshineSeconds");
  if (temperature === null || sunshine === null) {
    return null;
  }
  return {
    dayMaxC: Math.max(...temperature),
    sunshineHours: roundTo(sunshine.reduce((sum, seconds) => sum + seconds, 0) / 3600, 6),
  };
}

/** Rows top to bottom, first match wins; every bound is "at least" (lower bound included). */
export function heaterBand(facts: HeaterFacts, config: RulesConfig): Band {
  const rule = config.chores.heater;
  const row = rule.rows.find(
    (candidate) =>
      facts.dayMaxC >= candidate.dayMaxCAtLeast &&
      (candidate.sunshineHoursAtLeast === undefined ||
        facts.sunshineHours >= candidate.sunshineHoursAtLeast),
  );
  return (row?.band ?? rule.otherwiseBand) as Band;
}
