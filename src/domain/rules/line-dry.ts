import type { Band } from "../bands.js";
import type { ForecastHour } from "../weather.js";

import type { RulesConfig } from "./schema.js";
import { coveredHours, hourDryingIndex, mean, roundTo } from "./window.js";

/** What the line-dry rule saw between now and 18:00. */
export interface LineDryFacts {
  readonly wetHours: number;
  /** Mean drying index D over the window's daylight hours; 0 when it has none. */
  readonly meanDryingIndex: number;
  readonly daylightHours: number;
  readonly maxTempC: number;
}

export function lineDryFacts(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
  config: RulesConfig,
): LineDryFacts | null {
  const hours = coveredHours(forecast, fromMs, toMs);
  if (hours === null) {
    return null;
  }
  const daylight = hours.filter((hour) => hour.isDay);
  return {
    wetHours: hours.filter((hour) => hour.precipitationMm >= config.wetHourMm).length,
    meanDryingIndex: roundTo(
      mean(daylight.map((hour) => hourDryingIndex(hour, config.dryingIndex, config.wetHourMm))),
      6,
    ),
    daylightHours: daylight.length,
    maxTempC: Math.max(...hours.map((hour) => hour.temperatureC)),
  };
}

/** Any wet hour → the wet band; else the first drying-index row the mean D reaches (lower bound included). */
export function lineDryBand(facts: LineDryFacts, config: RulesConfig): Band {
  const rule = config.chores.lineDry;
  if (facts.wetHours > 0) {
    return rule.anyWetHourBand as Band;
  }
  const row = rule.meanDryingIndexRows.find(
    (candidate) => facts.meanDryingIndex >= candidate.atLeast,
  );
  return (row?.band ?? rule.otherwiseBand) as Band;
}
