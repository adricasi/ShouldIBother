import type { Band } from "../bands.js";
import { hoursInWindow, type ForecastHour } from "../weather.js";

import type { PlantsRow, RulesConfig } from "./schema.js";

/** What the plants rule saw in its window; shown in the rule's reason. */
export interface PlantsFacts {
  readonly rainMm: number;
  readonly maxHourlyProbabilityPct: number;
  readonly maxTempC: number;
  readonly hours: number;
}

/** Hourly values come in 0.1 mm steps; summing floats must not turn 5.0 into 4.999999. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Reads the forecast over `[fromMs, toMs)`; null when the forecast has no hour in the window. */
export function plantsFacts(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
): PlantsFacts | null {
  const hours = hoursInWindow(forecast, fromMs, toMs);
  if (hours.length === 0) {
    return null;
  }
  return {
    rainMm: roundTo(
      hours.reduce((sum, hour) => sum + hour.precipitationMm, 0),
      4,
    ),
    maxHourlyProbabilityPct: Math.max(...hours.map((hour) => hour.precipitationProbabilityPct)),
    maxTempC: Math.max(...hours.map((hour) => hour.temperatureC)),
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
