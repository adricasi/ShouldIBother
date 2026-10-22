import { hoursInWindow, type ForecastHour } from "../weather.js";

import { presentValues } from "./window.js";

import type { RulesConfig } from "./schema.js";

export type SafetyKind = "heat" | "frost" | "storm";

/** A "Do it now" alert: the fixed backstop fired, whatever Gemma says (AC-012.1). */
export interface SafetyAlert {
  readonly kinds: readonly SafetyKind[];
  /** Plain sentence shown on the card, e.g. "Heat: up to 36 °C expected." */
  readonly reason: string;
}

const KIND_ORDER: readonly SafetyKind[] = ["storm", "heat", "frost"];

/**
 * The fixed heat, frost and storm backstop over `[fromMs, toMs)` (design.md, Rule baseline and
 * safety backstop). Heat: max temperature at or above the limit. Frost: min temperature at or
 * below the limit. Storm: a gust at or above the limit, or a thunderstorm weather code (WMO
 * 95–99). It looks at every forecast hour that overlaps the window and never needs the window to
 * be covered: a missing hour cannot hide a limit that the hours present already cross.
 */
export function safetyAlert(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
  config: RulesConfig,
): SafetyAlert | null {
  const hours = hoursInWindow(forecast, fromMs, toMs);
  const limits = config.safetyBackstop;
  // Each limit looks at the values that are there: an hour with a missing humidity or sunshine
  // still counts for its temperature, gust and weather code, and a missing one never hides another.
  const temperatures = presentValues(hours, "temperatureC");
  const gusts = presentValues(hours, "gustKmh");
  const codes = presentValues(hours, "weatherCode");
  const maxTempC = temperatures.length === 0 ? undefined : Math.max(...temperatures);
  const minTempC = temperatures.length === 0 ? undefined : Math.min(...temperatures);
  const maxGustKmh = gusts.length === 0 ? undefined : Math.max(...gusts);
  const stormCode = codes.find((code) => limits.stormWmoCodes.includes(code));

  const reasons = new Map<SafetyKind, string>();
  if (
    (maxGustKmh !== undefined && maxGustKmh >= limits.stormGustKmhAtLeast) ||
    stormCode !== undefined
  ) {
    reasons.set(
      "storm",
      stormCode !== undefined
        ? "Storm: thunderstorms are forecast."
        : `Storm: gusts up to ${maxGustKmh} km/h are forecast.`,
    );
  }
  if (maxTempC !== undefined && maxTempC >= limits.heatMaxCAtLeast) {
    reasons.set("heat", `Heat: up to ${maxTempC} °C is forecast.`);
  }
  if (minTempC !== undefined && minTempC <= limits.frostMinCAtMost) {
    reasons.set("frost", `Frost: down to ${minTempC} °C is forecast.`);
  }
  const kinds = KIND_ORDER.filter((kind) => reasons.has(kind));
  if (kinds.length === 0) {
    return null;
  }
  return { kinds, reason: kinds.map((kind) => reasons.get(kind)).join(" ") };
}
