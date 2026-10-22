/**
 * Every Open-Meteo endpoint, query parameter and variable name used by the weather snapshot.
 *
 * UNVERIFIED: written without access to Open-Meteo (blocked in the build environment).
 * T-031 (real snapshot) and T-001 (spike 3) must check each value below against the live API
 * and its documentation before the real snapshot is taken: hosts and paths, the
 * `_previous_day1` variable suffix, the `unixtime` time format, which variables each API
 * offers for Gràcia from April 2026, whether `end_date` beyond the archive's last day is
 * accepted (nulls) or rejected, the `models` parameter for Previous Runs, and the hour-stamp
 * convention of sum variables (`SUM_VARIABLE_STAMP` in `src/domain/open-meteo.ts`).
 *
 * Hosts come from `src/domain/open-meteo.ts`, shared with the weather client's allowlist
 * (design.md, AC-014.7).
 */

import { OPEN_METEO_HOSTS, SUM_VARIABLE_NAMES } from "../domain/open-meteo.js";

export { ATTRIBUTION, COORDINATE_DECIMALS, LICENSE } from "../domain/open-meteo.js";

export const OPEN_METEO_SOURCES = {
  previousRunsDay1: {
    baseUrl: `https://${OPEN_METEO_HOSTS.previousRuns}/v1/forecast`,
    /** Variable name = base name + this suffix (day-1 lead forecast). */
    variableSuffix: "_previous_day1",
    includesDaily: false,
  },
  historicalForecast: {
    baseUrl: `https://${OPEN_METEO_HOSTS.historicalForecast}/v1/forecast`,
    variableSuffix: "",
    includesDaily: false,
  },
  archive: {
    baseUrl: `https://${OPEN_METEO_HOSTS.archive}/v1/archive`,
    variableSuffix: "",
    includesDaily: true,
  },
} as const;
export type SnapshotSourceKey = keyof typeof OPEN_METEO_SOURCES;

/**
 * The snapshot calls the three historical APIs only; the live forecast host
 * (`api.open-meteo.com`) belongs to the weather client's allowlist, defined next to these names
 * in `src/domain/open-meteo.ts`.
 */
export const ALLOWED_HOSTS: readonly string[] = [
  OPEN_METEO_HOSTS.previousRuns,
  OPEN_METEO_HOSTS.historicalForecast,
  OPEN_METEO_HOSTS.archive,
];

/** Hourly variables, by Open-Meteo name. */
export const WEATHER_VARIABLES = [
  "temperature_2m",
  "dew_point_2m",
  "relative_humidity_2m",
  "precipitation",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_gusts_10m",
  "weather_code",
  "sunshine_duration",
  "et0_fao_evapotranspiration",
] as const;
export type WeatherVariable = (typeof WEATHER_VARIABLES)[number];

/** Hourly variables requested per source (probability and ET0 are not offered everywhere). */
export const SOURCE_VARIABLES: Readonly<Record<SnapshotSourceKey, readonly WeatherVariable[]>> = {
  previousRunsDay1: [
    "temperature_2m",
    "dew_point_2m",
    "relative_humidity_2m",
    "precipitation",
    "precipitation_probability",
    "wind_speed_10m",
    "wind_gusts_10m",
    "weather_code",
    "sunshine_duration",
  ],
  historicalForecast: [
    "temperature_2m",
    "dew_point_2m",
    "relative_humidity_2m",
    "precipitation",
    "precipitation_probability",
    "wind_speed_10m",
    "wind_gusts_10m",
    "weather_code",
    "sunshine_duration",
  ],
  archive: [
    "temperature_2m",
    "dew_point_2m",
    "relative_humidity_2m",
    "precipitation",
    "wind_speed_10m",
    "wind_gusts_10m",
    "weather_code",
    "sunshine_duration",
    "et0_fao_evapotranspiration",
  ],
};

export const DAILY_VARIABLE_SUNSET = "sunset";

/** Query parameter names and fixed values. */
export const QUERY = {
  latitude: "latitude",
  longitude: "longitude",
  startDate: "start_date",
  endDate: "end_date",
  hourly: "hourly",
  daily: "daily",
  timezone: "timezone",
  timeFormat: "timeformat",
  timezoneValue: "Europe/Madrid",
  /** Epoch seconds (UTC): unambiguous across the DST changes. */
  timeFormatValue: "unixtime",
} as const;

/** Response field names. */
export const RESPONSE = { hourly: "hourly", daily: "daily", time: "time" } as const;

/**
 * Previous Runs day-1 lead: the value for hour H comes from a model run that started no later
 * than H - 24 h. This is the conservative bound used as the value's "issued at" instant.
 * T-001 / T-031 confirm the run selection.
 */
export const DAY1_LEAD_HOURS = 24;

export { SUM_VARIABLE_STAMP, type HourStamp } from "../domain/open-meteo.js";

export const SUM_VARIABLES: readonly WeatherVariable[] = SUM_VARIABLE_NAMES;

/**
 * Variables every source must actually deliver (non-null somewhere). A source that returns one
 * of them as all-null fails the snapshot build. Precipitation probability and ET0 are
 * deliberately not core: both have labelled fallbacks.
 */
export const CORE_VARIABLES: readonly WeatherVariable[] = [
  "temperature_2m",
  "dew_point_2m",
  "relative_humidity_2m",
  "precipitation",
  "wind_speed_10m",
  "sunshine_duration",
];

/** Request timeout for the real fetch. */
export const REQUEST_TIMEOUT_MS = 30_000;
