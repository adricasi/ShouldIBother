/**
 * Every Open-Meteo endpoint, query parameter and variable name used by the weather snapshot.
 *
 * UNVERIFIED: written without access to Open-Meteo (blocked in the build environment).
 * T-031 (real snapshot) and T-001 (spike 3) must check each value below against the live API
 * and its documentation before the real snapshot is taken: hosts and paths, the
 * `_previous_day1` variable suffix, the `unixtime` time format, which variables each API
 * offers for Gràcia from April 2026, whether `end_date` beyond the archive's last day is
 * accepted (nulls) or rejected, the `models` parameter for Previous Runs, and the hour-stamp
 * convention of sum variables (`SUM_VARIABLE_STAMP` below).
 *
 * Hosts match the weather client allowlist in design.md (AC-014.7).
 */

export const ATTRIBUTION =
  "Weather data by Open-Meteo.com (https://open-meteo.com/), licensed CC BY 4.0.";
export const LICENSE = "CC BY 4.0";

export const OPEN_METEO_SOURCES = {
  previousRunsDay1: {
    baseUrl: "https://previous-runs-api.open-meteo.com/v1/forecast",
    /** Variable name = base name + this suffix (day-1 lead forecast). */
    variableSuffix: "_previous_day1",
    includesDaily: false,
  },
  historicalForecast: {
    baseUrl: "https://historical-forecast-api.open-meteo.com/v1/forecast",
    variableSuffix: "",
    includesDaily: false,
  },
  archive: {
    baseUrl: "https://archive-api.open-meteo.com/v1/archive",
    variableSuffix: "",
    includesDaily: true,
  },
} as const;
export type SnapshotSourceKey = keyof typeof OPEN_METEO_SOURCES;

export const ALLOWED_HOSTS: readonly string[] = [
  "previous-runs-api.open-meteo.com",
  "historical-forecast-api.open-meteo.com",
  "archive-api.open-meteo.com",
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

/** Coordinates are rounded to 2 decimals before any request (NFR-002, AC-014.1). */
export const COORDINATE_DECIMALS = 2;

/** Which instant a hourly value is stamped with. */
export type HourStamp = "hour_start" | "hour_end";

/**
 * Sum-type variables (precipitation, sunshine duration, ET0) may be stamped with the END of the
 * hour they cover (the value at 10:00 being the sum over 09:00-10:00) instead of its start.
 * Instantaneous variables (temperature, humidity, wind, ...) are not affected.
 *
 * UNVERIFIED: T-031 must check this against the real API and change this one switch if needed.
 * "hour_start" keeps every value on the hour it is stamped with; "hour_end" shifts the sum
 * variables back one hour when the snapshot is built, so the snapshot always stores hour-start
 * aligned data. The convention used is recorded in the snapshot.
 */
export const SUM_VARIABLE_STAMP: HourStamp = "hour_start";

export const SUM_VARIABLES: readonly WeatherVariable[] = [
  "precipitation",
  "sunshine_duration",
  "et0_fao_evapotranspiration",
];

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
