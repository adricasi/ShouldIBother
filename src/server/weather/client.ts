import type { HourlyWeather } from "../../domain/outcomes.js";
import type { ForecastHour } from "../../domain/weather.js";

export interface Forecast {
  /** When the forecast was fetched, epoch milliseconds (shown as its age, REQ-014). */
  readonly fetchedAt: number;
  readonly hours: readonly ForecastHour[];
}

/**
 * Weather recorded (modelled recent weather) for a bet's window (ADR-0008). `complete` is true
 * when every hour of the window is present with the values the judge and the outcome labels need;
 * until then the bet keeps waiting (AC-014.5).
 */
export interface RecordedWeather {
  readonly fetchedAt: number;
  readonly complete: boolean;
  /** The hours that overlap the window, in time order (all of them when complete). */
  readonly hours: readonly HourlyWeather[];
}

/** Where weather comes from. The Open-Meteo client serves the live app; tests and CI use the fake. */
export interface WeatherClient {
  /** Hourly forecast from the hour containing `fromMs`, `hours` hours long. */
  getForecast(request: { readonly fromMs: number; readonly hours: number }): Promise<Forecast>;
  /** Recorded hours of `[fromMs, toMs)` for settlement. Throws when the service cannot be reached. */
  getRecorded(request: {
    readonly fromMs: number;
    readonly toMs: number;
  }): Promise<RecordedWeather>;
  /** When the newest usable forecast was fetched, without a network call (Today's forecast age). */
  latestForecastFetchedAt(): number | undefined;
}

/** No forecast could be obtained (offline, timeout, bad answer, no recent cache). */
export class WeatherUnavailableError extends Error {
  override readonly name = "WeatherUnavailableError";
}

/** A forecast is reused for at most 1 h (AC-014.2). */
export const FORECAST_TTL_MS = 60 * 60 * 1000;
/** Without a forecast younger than 24 h the app sets no odds (AC-014.4, assumption A-10). */
export const FORECAST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
