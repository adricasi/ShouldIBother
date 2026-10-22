import type { Band } from "../bands.js";
import { hoursInWindow, windowIsCovered, type ForecastHour } from "../weather.js";

import type { PlantsRow, RulesConfig } from "./schema.js";
import { allValues, presentValues, roundTo } from "./window.js";

/** What the plants rule saw in its window; shown in the rule's reason. */
export interface PlantsFacts {
  readonly rainMm: number;
  /** Null when the forecast has no probability for the window: that condition is then skipped. */
  readonly maxHourlyProbabilityPct: number | null;
  readonly maxTempC: number;
  readonly hours: number;
}

/**
 * Reads the forecast over `[fromMs, toMs)`; null unless the forecast covers the whole window
 * without a gap: a partly covered window would understate the rain and give false odds.
 */
export function plantsFacts(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
): PlantsFacts | null {
  if (!windowIsCovered(forecast, fromMs, toMs)) {
    return null;
  }
  const hours = hoursInWindow(forecast, fromMs, toMs);
  const rain = allValues(hours, "precipitationMm");
  const temperature = allValues(hours, "temperatureC");
  if (rain === null || temperature === null) {
    return null; // the rain total or the high is unknown: no false odds
  }
  const probabilities = presentValues(hours, "precipitationProbabilityPct");
  return {
    rainMm: roundTo(
      rain.reduce((sum, value) => sum + value, 0),
      4,
    ),
    maxHourlyProbabilityPct: probabilities.length === 0 ? null : Math.max(...probabilities),
    maxTempC: Math.max(...temperature),
    hours: hours.length,
  };
}

function rowMatches(row: PlantsRow, facts: PlantsFacts): boolean {
  // Lower bounds are included ("at least"), upper bounds excluded ("below"): half-open intervals.
  if (row.rainMmAtLeast !== undefined && !(facts.rainMm >= row.rainMmAtLeast)) {
    return false;
  }
  if (row.maxTempCBelow !== undefined && !(facts.maxTempC < row.maxTempCBelow)) {
    return false;
  }
  if (row.anyOf !== undefined) {
    const { rainMmAtLeast, maxHourlyProbabilityPctAtLeast } = row.anyOf;
    const anyHolds =
      (rainMmAtLeast !== undefined && facts.rainMm >= rainMmAtLeast) ||
      (maxHourlyProbabilityPctAtLeast !== undefined &&
        facts.maxHourlyProbabilityPct !== null &&
        facts.maxHourlyProbabilityPct >= maxHourlyProbabilityPctAtLeast);
    if (!anyHolds) {
      return false;
    }
  }
  return true;
}

/**
 * Rule band for "water balcony plants" (design.md, Rule baseline): rows top to bottom, the first
 * match wins, else `otherwiseBand`. Pure: thresholds come from `config/rules.json`.
 */
export function plantsBand(facts: PlantsFacts, config: RulesConfig): Band {
  const { rows, otherwiseBand } = config.chores.plants;
  const matched = rows.find((row) => rowMatches(row, facts));
  return (matched?.band ?? otherwiseBand) as Band;
}
