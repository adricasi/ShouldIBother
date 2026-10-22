import type { ForecastHour } from "../../domain/weather.js";

export interface Forecast {
  /** When the forecast was fetched, epoch milliseconds (shown as its age, REQ-014). */
  readonly fetchedAt: number;
  readonly hours: readonly ForecastHour[];
}

/** Where forecasts come from. T-005 adds the Open-Meteo client; tests and CI use the fake. */
export interface WeatherClient {
  /** Hourly forecast from the hour containing `fromMs`, `hours` hours long. */
  getForecast(request: { readonly fromMs: number; readonly hours: number }): Promise<Forecast>;
}

/** No forecast could be obtained (offline, timeout, bad answer). */
export class WeatherUnavailableError extends Error {
  override readonly name = "WeatherUnavailableError";
}
