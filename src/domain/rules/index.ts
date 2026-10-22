import { nameOfBand, oddsOfBand, type Band, type BandTable } from "../bands.js";
import type { OutcomeChore } from "../outcomes.js";
import type { ForecastHour } from "../weather.js";

import { acBand, acFacts } from "./ac.js";
import { heaterBand, heaterFacts } from "./heater.js";
import { laundryTonightBand, laundryTonightFacts } from "./laundry-tonight.js";
import { lineDryBand, lineDryFacts } from "./line-dry.js";
import { plantsBand, plantsFacts } from "./plants.js";
import type { RulesConfig } from "./schema.js";

export { parseRulesConfig, type RulesConfig } from "./schema.js";
export { plantsBand, plantsFacts, type PlantsFacts } from "./plants.js";
export { lineDryBand, lineDryFacts, type LineDryFacts } from "./line-dry.js";
export {
  laundryTonightBand,
  laundryTonightFacts,
  type LaundryTonightFacts,
} from "./laundry-tonight.js";
export { acBand, acFacts, type AcFacts } from "./ac.js";
export { heaterBand, heaterFacts, type HeaterFacts } from "./heater.js";
export { safetyAlert, type SafetyAlert, type SafetyKind } from "./safety.js";

export function bandTable(config: RulesConfig): BandTable {
  return { names: config.bandNames, odds: config.bandOdds };
}

/** The rule baseline for one card: its band and a plain sentence on what the forecast showed. */
export interface RuleQuote {
  readonly band: Band;
  readonly reason: string;
}

function sentence(config: RulesConfig, band: Band, seen: string, forWhat: string): RuleQuote {
  const table = bandTable(config);
  return {
    band,
    reason: `Rule: ${seen} That is ${nameOfBand(table, band)} (${oddsOfBand(table, band)}%) for ${forWhat}.`,
  };
}

/**
 * The rule baseline of a chore over `[fromMs, toMs)` (design.md, Rule baseline and safety
 * backstop): the band of the first matching row, computed without Gemma. Null when the forecast
 * does not cover the window, so a missing hour never produces false odds.
 */
export function ruleQuote(
  chore: OutcomeChore,
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
  config: RulesConfig,
): RuleQuote | null {
  switch (chore) {
    case "plants": {
      const facts = plantsFacts(forecast, fromMs, toMs);
      return facts === null
        ? null
        : sentence(
            config,
            plantsBand(facts, config),
            `${facts.rainMm} mm of rain expected, ${facts.maxHourlyProbabilityPct === null ? "" : `up to ${facts.maxHourlyProbabilityPct}% chance in an hour, `}high of ${facts.maxTempC} °C.`,
            "skipping the watering",
          );
    }
    case "laundry_line": {
      const facts = lineDryFacts(forecast, fromMs, toMs, config);
      if (facts === null) {
        return null;
      }
      return sentence(
        config,
        lineDryBand(facts, config),
        facts.wetHours > 0
          ? `rain is forecast in ${facts.wetHours} ${facts.wetHours === 1 ? "hour" : "hours"} before the load would be dry.`
          : `no rain expected, drying index ${facts.meanDryingIndex.toFixed(2)} (wind, dry air and sun) over ${facts.daylightHours} daylight hours.`,
        "drying on the line",
      );
    }
    case "laundry_tonight": {
      const facts = laundryTonightFacts(forecast, fromMs, toMs, config);
      if (facts === null) {
        return null;
      }
      const seen =
        facts.wetHours > 0
          ? `rain is forecast in ${facts.wetHours} ${facts.wetHours === 1 ? "hour" : "hours"} overnight.`
          : `${facts.dewHours} ${facts.dewHours === 1 ? "hour" : "hours"} of dew risk overnight, drying index ${facts.meanDryingIndex.toFixed(2)}.`;
      return sentence(config, laundryTonightBand(facts, config), seen, "leaving the laundry out");
    }
    case "ac": {
      const facts = acFacts(forecast, fromMs, toMs);
      return facts === null
        ? null
        : sentence(
            config,
            acBand(facts, config),
            `night low of ${facts.nightMinC} °C, average wind ${facts.meanWindKmh} km/h.`,
            "sleeping without the AC",
          );
    }
    case "heater": {
      const facts = heaterFacts(forecast, fromMs, toMs);
      return facts === null
        ? null
        : sentence(
            config,
            heaterBand(facts, config),
            `high of ${facts.dayMaxC} °C with ${facts.sunshineHours} h of sun.`,
            "skipping the heater",
          );
    }
  }
}

/**
 * Rule baseline for a plants card over `[fromMs, toMs)` (now to the settle time); kept as the
 * name the walking skeleton used. See `ruleQuote` for every chore.
 */
export function plantsRuleQuote(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
  config: RulesConfig,
): RuleQuote | null {
  return ruleQuote("plants", forecast, fromMs, toMs, config);
}
