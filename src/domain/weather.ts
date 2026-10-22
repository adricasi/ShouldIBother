import { HOUR_MS } from "./time.js";

/** One hour of forecast, as Gemma's `get_forecast` tool returns it (design.md, Interfaces). */
export interface ForecastHour {
  /** Start of the hour, epoch milliseconds. */
  readonly startsAt: number;
  readonly precipitationMm: number;
  readonly precipitationProbabilityPct: number;
  readonly temperatureC: number;
  readonly dewPointC: number;
  readonly relativeHumidityPct: number;
  readonly windKmh: number;
  readonly gustKmh: number;
  readonly sunshineSeconds: number;
  readonly weatherCode: number;
  /** Daylight at the start of the hour (Open-Meteo `is_day`); the line-dry rule averages D over daylight hours. */
  readonly isDay: boolean;
}

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
