/**
 * Endpoint, query parameter and variable names of the live weather client (forecast and past
 * hours). Hosts, attribution, coordinate rounding and the hour-stamp switch are shared with the
 * backtest snapshot in `src/domain/open-meteo.ts`.
 *
 * UNVERIFIED: written without access to Open-Meteo (blocked in the build environment, tests use
 * a fake HTTP server). T-001 (spike 3) and T-010 must check every value below against the live
 * API and its documentation: the path `/v1/forecast`; the hourly variable names, including
 * `is_day`, `precipitation_probability` and `et0_fao_evapotranspiration`; the `forecast_days`, `past_days`,
 * `start_date`, `end_date`, `timezone` and `timeformat=unixtime` parameters; that the forecast
 * API answers `start_date`/`end_date` ranges in the recent past (settlement uses them); the
 * default units (mm, km/h, °C, seconds of sunshine); and the error body shape.
 */

import { OPEN_METEO_HOSTS } from "../../domain/open-meteo.js";

export const FORECAST_URL = `https://${OPEN_METEO_HOSTS.forecast}/v1/forecast`;

/** Hourly variables read from the forecast API, by the field of an hour they fill. */
export const HOURLY_VARIABLES = {
  temperatureC: "temperature_2m",
  dewPointC: "dew_point_2m",
  relativeHumidityPct: "relative_humidity_2m",
  precipitationMm: "precipitation",
  precipitationProbabilityPct: "precipitation_probability",
  windKmh: "wind_speed_10m",
  gustKmh: "wind_gusts_10m",
  weatherCode: "weather_code",
  sunshineSeconds: "sunshine_duration",
  isDay: "is_day",
  et0Mm: "et0_fao_evapotranspiration",
} as const;

export type HourlyField = keyof typeof HOURLY_VARIABLES;

export const QUERY = {
  latitude: "latitude",
  longitude: "longitude",
  hourly: "hourly",
  forecastDays: "forecast_days",
  pastDays: "past_days",
  startDate: "start_date",
  endDate: "end_date",
  timezone: "timezone",
  timeFormat: "timeformat",
  timezoneValue: "Europe/Madrid",
  /** Epoch seconds (UTC): unambiguous across the clock changes. */
  timeFormatValue: "unixtime",
} as const;

/** Days of forecast requested: today and the two after it cover every window and `hours_ahead ≤ 48`. */
export const FORECAST_DAYS = 3;
/**
 * Yesterday as well: a window that began before now (the AC's night from 22:00, the heater's day
 * from 08:00) is priced whole, so the live band equals the band the backtest labels use.
 */
export const FORECAST_PAST_DAYS = 1;
