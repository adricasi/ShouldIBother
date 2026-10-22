import { HOUR_MS } from "./time.js";

/**
 * One hour of forecast, as Gemma's `get_forecast` tool returns it (design.md, Interfaces).
 * A value Open-Meteo did not provide for the hour is `null`: the hour is kept, because the safety
 * backstop must see an extreme temperature, gust or storm code even when other values are missing.
 * A rule that needs a missing value cannot price its window and gives no quote.
 */
export interface ForecastHour {
  /** Start of the hour, epoch milliseconds. */
  readonly startsAt: number;
  readonly precipitationMm: number | null;
  readonly precipitationProbabilityPct: number | null;
  readonly temperatureC: number | null;
  readonly dewPointC: number | null;
  readonly relativeHumidityPct: number | null;
  readonly windKmh: number | null;
  readonly gustKmh: number | null;
  readonly sunshineSeconds: number | null;
  readonly weatherCode: number | null;
  /** Daylight at the start of the hour (Open-Meteo `is_day`); the line-dry rule averages D over daylight hours. */
  readonly isDay: boolean | null;
}

/** The numeric values of an hour: every field but its start and `isDay`. */
export type ForecastField = Exclude<keyof ForecastHour, "startsAt" | "isDay">;

export { HOUR_MS } from "./time.js";

/** The forecast hours that overlap `[fromMs, toMs)`; an hour covers `[startsAt, startsAt + 1 h)`. */
export function hoursInWindow(
  hours: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
): ForecastHour[] {
  return hours.filter((hour) => hour.startsAt < toMs && hour.startsAt + HOUR_MS > fromMs);
}

/**
 * True when consecutive forecast hours cover every instant of `[fromMs, toMs)`: the first hour
 * starts at or before `fromMs`, no hour is missing in between, and the last one ends at or after
 * `toMs`.
 */
export function windowIsCovered(
  hours: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
): boolean {
  const inWindow = hoursInWindow(hours, fromMs, toMs).sort((a, b) => a.startsAt - b.startsAt);
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  if (first === undefined || last === undefined) {
    return false;
  }
  if (first.startsAt > fromMs || last.startsAt + HOUR_MS < toMs) {
    return false;
  }
  return inWindow.every((hour, index) => {
    const previous = inWindow[index - 1];
    return previous === undefined || hour.startsAt === previous.startsAt + HOUR_MS;
  });
}

/** "Forecast from 3 h ago": how old the forecast behind the odds is (AC-014.3). */
export function forecastAgeLabel(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 1) {
    return "Forecast from just now";
  }
  if (minutes < 60) {
    return `Forecast from ${minutes} min ago`;
  }
  return `Forecast from ${Math.floor(minutes / 60)} h ago`;
}
