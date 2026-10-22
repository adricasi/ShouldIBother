import type { Band } from "../bands.js";
import type { ForecastHour } from "../weather.js";

import type { RulesConfig } from "./schema.js";
import { allValues, coveredHours, mean, roundTo } from "./window.js";

/** What the "skip the AC" rule saw between 22:00 and 07:00. */
export interface AcFacts {
  readonly nightMinC: number;
  readonly meanWindKmh: number;
}

export function acFacts(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
): AcFacts | null {
  const hours = coveredHours(forecast, fromMs, toMs);
  if (hours === null) {
    return null;
  }
  const temperature = allValues(hours, "temperatureC");
  const wind = allValues(hours, "windKmh");
  if (temperature === null || wind === null) {
    return null;
  }
  return { nightMinC: Math.min(...temperature), meanWindKmh: roundTo(mean(wind), 4) };
}

/** Night minimum rows (upper bounds excluded), then a breeze lifts the band by one, up to the maximum. */
export function acBand(facts: AcFacts, config: RulesConfig): Band {
  const rule = config.chores.ac;
  const row = rule.nightMinCRows.find((candidate) => facts.nightMinC < candidate.below);
  const base = row?.band ?? rule.otherwiseBand;
  const lifted =
    facts.meanWindKmh >= rule.windLift.meanWindKmhAtLeast
      ? Math.min(base + rule.windLift.bands, rule.windLift.maxBand)
      : base;
  return lifted as Band;
}
