import { dryingIndex, type DryingIndexWeights } from "../outcomes.js";
import {
  hoursInWindow,
  windowIsCovered,
  type ForecastField,
  type ForecastHour,
} from "../weather.js";

/**
 * The forecast hours of `[fromMs, toMs)`, or null unless they cover the whole window without a
 * gap: a partly covered window would understate the rain (or the dew) and give false odds.
 */
export function coveredHours(
  forecast: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
): ForecastHour[] | null {
  if (!windowIsCovered(forecast, fromMs, toMs)) {
    return null;
  }
  return hoursInWindow(forecast, fromMs, toMs).sort((a, b) => a.startsAt - b.startsAt);
}

/** Values come in 0.1 steps; summing or averaging floats must not turn 5.0 into 4.999999. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The values of `field` over `hours`; null when any hour lacks it (the rule cannot price the window). */
export function allValues(hours: readonly ForecastHour[], field: ForecastField): number[] | null {
  const values: number[] = [];
  for (const hour of hours) {
    const value = hour[field];
    if (value === null) {
      return null;
    }
    values.push(value);
  }
  return values;
}

/** The values of `field` that are there; a rule that can do without the rest uses these. */
export function presentValues(hours: readonly ForecastHour[], field: ForecastField): number[] {
  return hours.flatMap((hour) => hour[field] ?? []);
}

/**
 * The drying index of each hour, with the outcome labels' formula and the config's weights; null
 * unless every hour has precipitation, wind, humidity and sunshine.
 */
export function dryingIndices(
  hours: readonly ForecastHour[],
  weights: DryingIndexWeights,
  wetHourMm: number,
): number[] | null {
  const precipitation = allValues(hours, "precipitationMm");
  const wind = allValues(hours, "windKmh");
  const humidity = allValues(hours, "relativeHumidityPct");
  const sunshine = allValues(hours, "sunshineSeconds");
  if (precipitation === null || wind === null || humidity === null || sunshine === null) {
    return null;
  }
  return hours.map((_hour, index) =>
    dryingIndex(
      {
        precipitationMm: precipitation[index] ?? 0,
        windSpeedKmh: wind[index] ?? 0,
        relativeHumidityPct: humidity[index] ?? 0,
        sunshineSeconds: sunshine[index] ?? 0,
      },
      weights,
      wetHourMm,
    ),
  );
}
