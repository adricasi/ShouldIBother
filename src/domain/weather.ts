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
}

export const HOUR_MS = 60 * 60 * 1000;

/** The forecast hours that overlap `[fromMs, toMs)`; an hour covers `[startsAt, startsAt + 1 h)`. */
export function hoursInWindow(
  hours: readonly ForecastHour[],
  fromMs: number,
  toMs: number,
): ForecastHour[] {
  return hours.filter((hour) => hour.startsAt < toMs && hour.startsAt + HOUR_MS > fromMs);
}
