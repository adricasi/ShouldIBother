/**
 * Synthetic Open-Meteo responses for tests: deterministic (hash-based, no randomness, no clock),
 * shaped like the real APIs as assumed in src/backtest/open-meteo.ts. Not real weather.
 */

import {
  HOUR_MS,
  addDays,
  dateRange,
  madridDateOf,
  madridWallTimeToEpochMs,
} from "../../../src/domain/outcomes.js";
import {
  fetchSnapshot,
  type FetchJson,
  type WeatherSnapshot,
} from "../../../src/backtest/snapshot.js";

const SERIES_START = "2026-04-01";
const SEASON_ORIGIN_MS = Date.UTC(2026, 3, 1);

/** Deterministic value in [0, 1) from integers. */
export function unit(...parts: number[]): number {
  let h = 2166136261;
  for (const part of parts) {
    h ^= part | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function dayIndex(timeMs: number): number {
  return Math.floor((timeMs - SEASON_ORIGIN_MS) / 86_400_000);
}

interface Hour {
  temperature: number;
  dewPoint: number;
  humidity: number;
  precipitation: number;
  probability: number;
  wind: number;
  gusts: number;
  code: number;
  sunshine: number;
  et0: number;
}

/** The "true" weather of an hour. */
export function truth(timeMs: number): Hour {
  const day = dayIndex(timeMs);
  const localHour = new Date(timeMs + 2 * HOUR_MS).getUTCHours();
  const seasonal = 14 + 15 * Math.sin((Math.PI * (day + 10)) / 200);
  const dayShift = (unit(day, 1) - 0.5) * 6;
  const temperature = seasonal + dayShift + 5 * Math.sin((2 * Math.PI * (localHour - 9)) / 24);
  const rainyDay = unit(day, 2) < 0.22;
  const rainHour = rainyDay && unit(day, localHour, 3) < 0.45;
  const precipitation = rainHour ? Math.round(unit(day, localHour, 4) * 40) / 10 : 0;
  const daylight = localHour >= 7 && localHour <= 19;
  const cloud = rainyDay ? 0.8 : unit(day, 5) * 0.6;
  return {
    temperature: Math.round(temperature * 10) / 10,
    dewPoint: Math.round((temperature - 2 - unit(day, localHour, 6) * 9) * 10) / 10,
    humidity: Math.round(45 + 40 * unit(day, 7) + (rainHour ? 15 : 0)),
    precipitation,
    probability: rainyDay ? 40 + Math.round(unit(day, 8) * 50) : Math.round(unit(day, 9) * 30),
    wind: Math.round((4 + 20 * unit(day, localHour, 10)) * 10) / 10,
    gusts: Math.round((10 + 30 * unit(day, localHour, 11)) * 10) / 10,
    code: rainHour ? 61 : 1,
    sunshine: daylight ? Math.round(3600 * (1 - cloud)) : 0,
    et0: daylight ? Math.round((0.05 + 0.3 * (1 - cloud)) * 100) / 100 : 0,
  };
}

/** A forecast of an hour: the truth plus a deterministic error. */
function forecastOf(timeMs: number, lead: number): Hour {
  const real = truth(timeMs);
  const error = (kind: number): number => (unit(timeMs / HOUR_MS, lead, kind) - 0.5) * 2;
  return {
    ...real,
    temperature: Math.round((real.temperature + 1.5 * error(1)) * 10) / 10,
    dewPoint: Math.round((real.dewPoint + 1.5 * error(2)) * 10) / 10,
    humidity: Math.min(100, Math.max(0, Math.round(real.humidity + 8 * error(3)))),
    precipitation: Math.max(0, Math.round((real.precipitation + 0.8 * error(4)) * 10) / 10),
    probability: Math.min(100, Math.max(0, Math.round(real.probability + 15 * error(5)))),
    wind: Math.max(0, Math.round((real.wind + 3 * error(6)) * 10) / 10),
    sunshine: Math.min(3600, Math.max(0, Math.round(real.sunshine + 400 * error(7)))),
  };
}

const FIELD_OF_VARIABLE: Record<string, (hour: Hour) => number> = {
  temperature_2m: (h) => h.temperature,
  dew_point_2m: (h) => h.dewPoint,
  relative_humidity_2m: (h) => h.humidity,
  precipitation: (h) => h.precipitation,
  precipitation_probability: (h) => h.probability,
  wind_speed_10m: (h) => h.wind,
  wind_gusts_10m: (h) => h.gusts,
  weather_code: (h) => h.code,
  sunshine_duration: (h) => h.sunshine,
  et0_fao_evapotranspiration: (h) => h.et0,
};

export interface FakeOpenMeteoOptions {
  /** Archive values are null after this Madrid date (default: no lag). */
  readonly archiveLastDay?: string;
  /** Archive ET0 comes back all null (plants fallback). */
  readonly archiveWithoutEt0?: boolean;
  /** Previous Runs does not return these base variable names. */
  readonly previousRunsOmit?: readonly string[];
  /** Historical Forecast does not return these base variable names. */
  readonly historicalOmit?: readonly string[];
  /** Previous Runs is null on these Madrid dates. */
  readonly previousRunsNullDates?: readonly string[];
  /** Applied to the archive truth, e.g. to change the hold-out period. */
  readonly archiveOverride?: (timeMs: number, variable: string, value: number) => number;
  /** Applied to forecasts (both forecast APIs). */
  readonly forecastOverride?: (timeMs: number, variable: string, value: number) => number;
}

export interface RecordedCall {
  readonly url: string;
}

function hoursOfDay(date: string): number[] {
  const start = madridWallTimeToEpochMs(date, "00:00");
  const end = madridWallTimeToEpochMs(addDays(date, 1), "00:00");
  const hours: number[] = [];
  for (let t = start; t < end; t += HOUR_MS) {
    hours.push(t);
  }
  return hours;
}

/** A fake `fetchJson` that answers Open-Meteo-shaped JSON for the three snapshot sources. */
export function fakeOpenMeteo(
  options: FakeOpenMeteoOptions = {},
  calls: RecordedCall[] = [],
): FetchJson {
  return (url) => {
    calls.push({ url });
    const parsed = new URL(url);
    const params = parsed.searchParams;
    const start = params.get("start_date") ?? SERIES_START;
    const end = params.get("end_date") ?? start;
    const isArchive = parsed.hostname === "archive-api.open-meteo.com";
    const isPrevious = parsed.hostname === "previous-runs-api.open-meteo.com";
    const requested = (params.get("hourly") ?? "").split(",").filter((name) => name !== "");

    const times: number[] = [];
    const dates: string[] = dateRange(start, end);
    for (const date of dates) {
      times.push(...hoursOfDay(date));
    }
    const hourly: Record<string, unknown> = { time: times.map((t) => t / 1000) };
    for (const name of requested) {
      const base = name.replace(/_previous_day1$/, "");
      const read = FIELD_OF_VARIABLE[base];
      if (read === undefined) {
        throw new Error(`fake Open-Meteo: unknown variable ${name}`);
      }
      const omitted = isPrevious
        ? options.previousRunsOmit?.includes(base) === true
        : !isArchive && options.historicalOmit?.includes(base) === true;
      if (omitted) {
        continue; // the API did not return the variable
      }
      hourly[name] = times.map((t) => {
        const date = madridDateOf(t);
        if (isArchive) {
          if (options.archiveLastDay !== undefined && date > options.archiveLastDay) return null;
          if (options.archiveWithoutEt0 === true && base === "et0_fao_evapotranspiration") {
            return null;
          }
          const value = read(truth(t));
          return options.archiveOverride?.(t, base, value) ?? value;
        }
        if (isPrevious && options.previousRunsNullDates?.includes(date) === true) return null;
        const value = read(forecastOf(t, isPrevious ? 24 : 1));
        return options.forecastOverride?.(t, base, value) ?? value;
      });
    }
    const body: Record<string, unknown> = { hourly };
    if (params.get("daily") === "sunset") {
      body["daily"] = {
        time: dates.map((date) => madridWallTimeToEpochMs(date, "00:00") / 1000),
        sunset: dates.map((date) => {
          const day = dayIndex(madridWallTimeToEpochMs(date, "12:00"));
          const minutes =
            19 * 60 + 40 + Math.round(95 * Math.sin((Math.PI * (day + 10)) / 200)) - 60;
          return (madridWallTimeToEpochMs(date, "00:00") + minutes * 60_000) / 1000;
        }),
      };
    }
    return Promise.resolve(body);
  };
}

/** A copy of the snapshot in which a source has no values for some variables. */
export function withoutVariables(
  snapshot: WeatherSnapshot,
  source: "previousRunsDay1" | "historicalForecast" | "archive",
  variables: readonly string[],
): WeatherSnapshot {
  const series = snapshot[source];
  const values = Object.fromEntries(
    Object.entries(series.values).map(([name, column]) => [
      name,
      variables.includes(name) ? column.map(() => null) : column,
    ]),
  );
  return { ...snapshot, [source]: { ...series, values } };
}

export const GRACIA = { name: "Gràcia, Barcelona", latitude: 41.4045, longitude: 2.1555 };

export async function syntheticSnapshot(
  options: FakeOpenMeteoOptions & { requestedEndDate?: string; startDate?: string } = {},
): Promise<WeatherSnapshot> {
  return fetchSnapshot({
    fetchJson: fakeOpenMeteo(options),
    location: GRACIA,
    startDate: options.startDate ?? SERIES_START,
    requestedEndDate: options.requestedEndDate ?? "2026-10-14",
    fetchedAt: "2026-10-22T09:00:00Z",
  });
}
