import type { Band } from "../bands.js";
import { isDewHour } from "../outcomes.js";
import type { ForecastHour } from "../weather.js";

import type { RulesConfig } from "./schema.js";
import { coveredHours, hourDryingIndex, mean, roundTo } from "./window.js";

/** What the "leave laundry out tonight" rule saw between sunset and 08:00. */
export interface LaundryTonightFacts {
  readonly wetHours: number;
  /** Hours with temp − dew point at or below the dew spread (dew would dampen the load). */
  readonly dewHours: number;
  readonly meanDryingIndex: number;
}

export function laundryTonightFacts(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
  config: RulesConfig,
): LaundryTonightFacts | null {
  const hours = coveredHours(forecast, fromMs, toMs);
  if (hours === null) {
    return null;
  }
  const spread = config.chores.laundryTonight.dew.tempMinusDewPointCAtMost;
  return {
    wetHours: hours.filter((hour) => hour.precipitationMm >= config.wetHourMm).length,
    dewHours: hours.filter((hour) => isDewHour(hour.temperatureC, hour.dewPointC, spread)).length,
    meanDryingIndex: roundTo(
      mean(hours.map((hour) => hourDryingIndex(hour, config.dryingIndex, config.wetHourMm))),
      6,
    ),
  };
}

/** First match wins: a wet hour, then dew, then the mean drying index rows, else the fallback. */
export function laundryTonightBand(facts: LaundryTonightFacts, config: RulesConfig): Band {
  const rule = config.chores.laundryTonight;
  if (facts.wetHours > 0) {
    return rule.anyWetHourBand as Band;
  }
  if (facts.dewHours >= rule.dew.hoursAtLeast) {
    return rule.dew.band as Band;
  }
  const row = rule.meanDryingIndexRows.find(
    (candidate) => facts.meanDryingIndex >= candidate.atLeast,
  );
  return (row?.band ?? rule.otherwiseBand) as Band;
}
