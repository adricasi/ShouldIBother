import type { Band } from "../bands.js";
import type { RainChore } from "../outcomes.js";
import { hoursInWindow, windowIsCovered, type ForecastHour } from "../weather.js";

import type { RainRow, RainRulesConfig, RulesConfig } from "./schema.js";
import { allValues, presentValues, roundTo } from "./window.js";

/** What a city rain bet's rule saw in its window (now to settle); shown in the rule's reason. */
export interface RainFacts {
  readonly rainMm: number;
  /** Null when the forecast has no probability for the window: that condition is then skipped. */
  readonly maxHourlyProbabilityPct: number | null;
  readonly hours: number;
}

/**
 * Reads the forecast over `[fromMs, toMs)`; null unless the forecast covers the whole window
 * without a gap and knows the rain of every hour: a partial total would understate the rain.
 */
export function rainFacts(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
): RainFacts | null {
  if (!windowIsCovered(forecast, fromMs, toMs)) {
    return null;
  }
  const hours = hoursInWindow(forecast, fromMs, toMs);
  const rain = allValues(hours, "precipitationMm");
  if (rain === null) {
    return null;
  }
  const probabilities = presentValues(hours, "precipitationProbabilityPct");
  return {
    rainMm: roundTo(
      rain.reduce((sum, value) => sum + value, 0),
      4,
    ),
    maxHourlyProbabilityPct: probabilities.length === 0 ? null : Math.max(...probabilities),
    hours: hours.length,
  };
}

function rowMatches(row: RainRow, facts: RainFacts): boolean {
  // Lower bounds are included ("at least"): half-open intervals like every other rule.
  if (row.rainMmAtLeast !== undefined && !(facts.rainMm >= row.rainMmAtLeast)) {
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

/** The `config/rules-rain.json` section of each rain bet. */
export const RAIN_RULE_KEYS = {
  car_rinse: "carRinse",
  bike_rinse: "bikeRinse",
  terrace_rinse: "terraceRinse",
  rain_fill: "rainFill",
} as const satisfies Readonly<
  Record<RainChore, keyof Omit<RainRulesConfig, "_comment" | "version">>
>;

/**
 * Rule band of a city rain bet (design.md, City rain bets): rows top to bottom, the first match
 * wins, else `otherwiseBand`. Pure: thresholds come from `config/rules-rain.json`.
 */
export function rainBand(chore: RainChore, facts: RainFacts, config: RulesConfig): Band {
  if (config.rain === undefined) {
    throw new Error("The city rain rows (config/rules-rain.json) are not loaded");
  }
  const { rows, otherwiseBand } = config.rain[RAIN_RULE_KEYS[chore]];
  const matched = rows.find((row) => rowMatches(row, facts));
  return (matched?.band ?? otherwiseBand) as Band;
}
