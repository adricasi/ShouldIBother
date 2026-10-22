import { nameOfBand, oddsOfBand, type Band, type BandTable } from "../bands.js";
import type { ForecastHour } from "../weather.js";

import { plantsBand, plantsFacts } from "./plants.js";
import type { RulesConfig } from "./schema.js";

export { parseRulesConfig, type RulesConfig } from "./schema.js";
export { plantsBand, plantsFacts, type PlantsFacts } from "./plants.js";

export function bandTable(config: RulesConfig): BandTable {
  return { names: config.bandNames, odds: config.bandOdds };
}

/** The rule baseline for one card: its band and a plain sentence on what the forecast showed. */
export interface RuleQuote {
  readonly band: Band;
  readonly reason: string;
}

/**
 * Rule baseline for a plants card over `[fromMs, toMs)` (now to the settle time). Null when the
 * forecast does not cover the window. T-005 adds the other chores next to this one.
 */
export function plantsRuleQuote(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
  config: RulesConfig,
): RuleQuote | null {
  const facts = plantsFacts(forecast, fromMs, toMs);
  if (facts === null) {
    return null;
  }
  const band = plantsBand(facts, config);
  const table = bandTable(config);
  return {
    band,
    reason: `Rule: ${facts.rainMm} mm of rain expected, up to ${facts.maxHourlyProbabilityPct}% chance in an hour, high of ${facts.maxTempC} °C. That is ${nameOfBand(table, band)} (${oddsOfBand(table, band)}%) for skipping the watering.`,
  };
}
