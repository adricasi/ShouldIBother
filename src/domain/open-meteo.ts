/**
 * What the live weather client and the backtest snapshot share about Open-Meteo: the host
 * names, the allowlist check, the attribution and the coordinate rounding (NFR-002, AC-014.1,
 * AC-014.6, AC-014.7). One definition, so the two can never disagree about which hosts the app
 * may call.
 *
 * UNVERIFIED: the host names are written without access to Open-Meteo (blocked in the build
 * environment). T-001 (spike 3) checks each one against the live API.
 */

export const OPEN_METEO_HOSTS = {
  forecast: "api.open-meteo.com",
  previousRuns: "previous-runs-api.open-meteo.com",
  historicalForecast: "historical-forecast-api.open-meteo.com",
  archive: "archive-api.open-meteo.com",
} as const;

/** Every host the app may call (design.md, Weather service): the weather client's allowlist. */
export const OPEN_METEO_ALLOWED_HOSTS: readonly string[] = Object.values(OPEN_METEO_HOSTS);

export const ATTRIBUTION =
  "Weather data by Open-Meteo.com (https://open-meteo.com/), licensed CC BY 4.0.";
export const LICENSE = "CC BY 4.0";

/** Coordinates are rounded to 2 decimals before any request (NFR-002, AC-014.1). */
export const COORDINATE_DECIMALS = 2;

export function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

export class DisallowedHostError extends Error {
  constructor(host: string) {
    super(`refusing to call host "${host}": not an allowed Open-Meteo host`);
    this.name = "DisallowedHostError";
  }
}

/**
 * Throws `DisallowedHostError` unless `url` is https, names no credentials or port and its host
 * is one of `allowedHosts`. Callers check before any request and after building the URL.
 */
export function assertAllowedUrl(
  url: string,
  allowedHosts: readonly string[] = OPEN_METEO_ALLOWED_HOSTS,
): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    !allowedHosts.includes(parsed.hostname)
  ) {
    throw new DisallowedHostError(parsed.host);
  }
}

/** Which instant a hourly value is stamped with. */
export type HourStamp = "hour_start" | "hour_end";

/**
 * Sum-type variables (precipitation, sunshine duration, ET0) may be stamped with the END of the
 * hour they cover (the value at 10:00 being the sum over 09:00-10:00) instead of its start.
 * Instantaneous variables (temperature, humidity, wind, ...) are not affected.
 *
 * UNVERIFIED: T-031 and T-001 must check this against the real API and change this one switch
 * if needed. "hour_start" keeps every value on the hour it is stamped with; "hour_end" shifts
 * the sum variables back one hour when a response is read, so the app and the snapshot always
 * work on hour-start aligned data. The live weather client and the backtest snapshot both read
 * this switch.
 */
export const SUM_VARIABLE_STAMP: HourStamp = "hour_start";

export const SUM_VARIABLE_NAMES = [
  "precipitation",
  "sunshine_duration",
  "et0_fao_evapotranspiration",
] as const;
