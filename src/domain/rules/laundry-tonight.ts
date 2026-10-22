import type { Band } from "../bands.js";
import { isDewHour } from "../outcomes.js";
import type { ForecastHour } from "../weather.js";

import type { RulesConfig } from "./schema.js";
import { allValues, coveredHours, dryingIndices, mean, roundTo } from "./window.js";

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
  const indices = dryingIndices(hours, config.dryingIndex, config.wetHourMm);
  const precipitation = allValues(hours, "precipitationMm");
  const temperature = allValues(hours, "temperatureC");
  const dewPoint = allValues(hours, "dewPointC");
  if (indices === null || precipitation === null || temperature === null || dewPoint === null) {
    return null;
  }
  const spread = config.chores.laundryTonight.dew.tempMinusDewPointCAtMost;
  return {
    wetHours: precipitation.filter((mm) => mm >= config.wetHourMm).length,
    dewHours: temperature.filter((value, index) => isDewHour(value, dewPoint[index] ?? 0, spread))
      .length,
    meanDryingIndex: roundTo(mean(indices), 6),
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
