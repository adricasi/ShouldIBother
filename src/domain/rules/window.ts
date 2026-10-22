import { dryingIndex, type DryingIndexWeights } from "../outcomes.js";
import { hoursInWindow, windowIsCovered, type ForecastHour } from "../weather.js";

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

/** The drying index of one forecast hour: the outcome labels' formula, with the config's weights. */
export function hourDryingIndex(
  hour: ForecastHour,
  weights: DryingIndexWeights,
  wetHourMm: number,
): number {
  return dryingIndex(
    {
      precipitationMm: hour.precipitationMm,
      windSpeedKmh: hour.windKmh,
      relativeHumidityPct: hour.relativeHumidityPct,
      sunshineSeconds: hour.sunshineSeconds,
    },
    weights,
    wetHourMm,
  );
}
