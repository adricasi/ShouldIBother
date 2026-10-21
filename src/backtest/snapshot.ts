/**
 * Weather snapshot: Previous Runs day-1 forecasts (decisions), Historical Forecast (labelled
 * fallback) and the archive incl. ET0 (outcomes) for one location, saved under
 * `data-snapshots/` with attribution and the end date (REQ-018, REQ-019, NFR-012).
 *
 * Weather access goes through an injected `FetchJson`, so tests use synthetic fixtures.
 * Nothing here reads the clock or generates randomness: the fetch time is an argument.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  addDays,
  dateRange,
  HOUR_MS,
  madridDateOf,
  madridWallTimeToEpochMs,
  type HourlyWeather,
} from "../domain/outcomes.js";
import {
  ALLOWED_HOSTS,
  ATTRIBUTION,
  COORDINATE_DECIMALS,
  DAILY_VARIABLE_SUNSET,
  LICENSE,
  OPEN_METEO_SOURCES,
  QUERY,
  RESPONSE,
  SOURCE_VARIABLES,
  WEATHER_VARIABLES,
  type SnapshotSourceKey,
  type WeatherVariable,
} from "./open-meteo.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_FILE_NAME = "snapshot.json";

/** Hourly values for one source, columnar. `timesMs` are hour starts (epoch ms), ascending. */
export interface HourlySeries {
  readonly timesMs: readonly number[];
  readonly values: Readonly<Partial<Record<WeatherVariable, readonly (number | null)[]>>>;
}

export interface SnapshotLocation {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface WeatherSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly attribution: string;
  readonly license: string;
  readonly location: SnapshotLocation;
  readonly timeZone: string;
  /** First day requested (Madrid date). */
  readonly startDate: string;
  /** The archive's last complete day (Madrid date): the hold-out ends here (AC-019.1). */
  readonly endDate: string;
  /** The end date the fetch asked for; the archive lags, so `endDate` can be earlier. */
  readonly requestedEndDate: string;
  /** Supplied by the caller (the CLI), recorded for provenance only. */
  readonly fetchedAt: string;
  readonly sources: Readonly<
    Record<SnapshotSourceKey, { readonly baseUrl: string; readonly variables: readonly string[] }>
  >;
  readonly previousRunsDay1: HourlySeries;
  readonly historicalForecast: HourlySeries;
  readonly archive: HourlySeries;
  /** Sunset instant (epoch ms) per Madrid date, from the archive's daily data. */
  readonly sunsetMsByDate: Readonly<Record<string, number>>;
}

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

export class DisallowedHostError extends Error {
  constructor(host: string) {
    super(`refusing to call host "${host}": not an allowed Open-Meteo host`);
    this.name = "DisallowedHostError";
  }
}

export type FetchJson = (url: string) => Promise<unknown>;

/** Real fetch with a timeout, for the CLI (T-031). Tests inject a fake instead. */
export const fetchJsonWithTimeout: FetchJson = async (url) => {
  assertAllowedUrl(url);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Open-Meteo answered ${response.status} for ${url}`);
  }
  return await response.json();
};

export function assertAllowedUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new DisallowedHostError(parsed.hostname);
  }
}

// ---------------------------------------------------------------------------------------------
// Variable <-> HourlyWeather mapping
// ---------------------------------------------------------------------------------------------

export const VARIABLE_FIELD: Readonly<
  Record<WeatherVariable, keyof Omit<HourlyWeather, "timeMs">>
> = {
  temperature_2m: "temperatureC",
  dew_point_2m: "dewPointC",
  relative_humidity_2m: "relativeHumidityPct",
  precipitation: "precipitationMm",
  precipitation_probability: "precipitationProbabilityPct",
  wind_speed_10m: "windSpeedKmh",
  wind_gusts_10m: "windGustsKmh",
  weather_code: "weatherCode",
  sunshine_duration: "sunshineSeconds",
  et0_fao_evapotranspiration: "et0Mm",
};

export type HourValues = Partial<Record<WeatherVariable, number | null>>;

/** Hour start -> that hour's values. */
export function indexSeries(series: HourlySeries): Map<number, HourValues> {
  const index = new Map<number, HourValues>();
  series.timesMs.forEach((timeMs, position) => {
    const values: HourValues = {};
    for (const variable of WEATHER_VARIABLES) {
      const column = series.values[variable];
      if (column !== undefined) {
        values[variable] = column[position] ?? null;
      }
    }
    index.set(timeMs, values);
  });
  return index;
}

/** Recorded (archive) hours as `HourlyWeather`, in time order. */
export function archiveHours(snapshot: WeatherSnapshot): HourlyWeather[] {
  return snapshot.archive.timesMs.map((timeMs, position) => {
    const hour: Record<string, number | null> = { timeMs };
    for (const variable of WEATHER_VARIABLES) {
      hour[VARIABLE_FIELD[variable]] = snapshot.archive.values[variable]?.[position] ?? null;
    }
    return hour as unknown as HourlyWeather;
  });
}

// ---------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------

export interface FetchSnapshotParams {
  readonly fetchJson: FetchJson;
  readonly location: SnapshotLocation;
  /** Madrid date, e.g. "2026-04-01". */
  readonly startDate: string;
  /** Madrid date the fetch asks for; the archive's last complete day can be earlier. */
  readonly requestedEndDate: string;
  /** Provenance only, e.g. an ISO timestamp from the CLI. Never read from the clock here. */
  readonly fetchedAt: string;
}

function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** One request per calendar month keeps responses small and the merge order fixed. */
export function monthChunks(
  startDate: string,
  endDate: string,
): { startDate: string; endDate: string }[] {
  const chunks: { startDate: string; endDate: string }[] = [];
  let chunkStart = startDate;
  while (chunkStart <= endDate) {
    const monthEnd = addDays(`${chunkStart.slice(0, 7)}-01`, 40).slice(0, 7) + "-01";
    const lastOfMonth = addDays(monthEnd, -1);
    const chunkEnd = lastOfMonth < endDate ? lastOfMonth : endDate;
    chunks.push({ startDate: chunkStart, endDate: chunkEnd });
    chunkStart = addDays(chunkEnd, 1);
  }
  return chunks;
}

export function buildRequestUrl(
  source: SnapshotSourceKey,
  location: SnapshotLocation,
  chunk: { startDate: string; endDate: string },
): string {
  const spec = OPEN_METEO_SOURCES[source];
  const hourly = SOURCE_VARIABLES[source].map((variable) => `${variable}${spec.variableSuffix}`);
  const params = new URLSearchParams();
  params.set(QUERY.latitude, String(roundCoordinate(location.latitude)));
  params.set(QUERY.longitude, String(roundCoordinate(location.longitude)));
  params.set(QUERY.startDate, chunk.startDate);
  params.set(QUERY.endDate, chunk.endDate);
  params.set(QUERY.hourly, hourly.join(","));
  if (spec.includesDaily) {
    params.set(QUERY.daily, DAILY_VARIABLE_SUNSET);
  }
  params.set(QUERY.timezone, QUERY.timezoneValue);
  params.set(QUERY.timeFormat, QUERY.timeFormatValue);
  return `${spec.baseUrl}?${params.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumberColumn(raw: unknown, length: number, label: string): (number | null)[] {
  if (raw === undefined) {
    // The API did not return the variable: treat as unavailable, so fallbacks apply.
    return new Array<number | null>(length).fill(null);
  }
  if (!Array.isArray(raw) || raw.length !== length) {
    throw new SnapshotFormatError(`${label}: expected an array of ${length} values`);
  }
  return raw.map((value: unknown) => {
    if (value === null) {
      return null;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new SnapshotFormatError(`${label}: values must be numbers or null`);
    }
    return value;
  });
}

function parseTimes(raw: unknown, label: string): number[] {
  if (!Array.isArray(raw)) {
    throw new SnapshotFormatError(`${label}: "time" must be an array`);
  }
  return raw.map((value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new SnapshotFormatError(`${label}: "time" entries must be unix seconds`);
    }
    return value * 1000;
  });
}

interface ParsedChunk {
  readonly timesMs: number[];
  readonly values: Partial<Record<WeatherVariable, (number | null)[]>>;
  readonly sunsetMsByDate: Record<string, number>;
}

/** Validates one API response (hand-written; no schema library in this task). */
export function parseOpenMeteoResponse(json: unknown, source: SnapshotSourceKey): ParsedChunk {
  const label = `${source} response`;
  if (!isRecord(json)) {
    throw new SnapshotFormatError(`${label}: expected a JSON object`);
  }
  const hourly = json[RESPONSE.hourly];
  if (!isRecord(hourly)) {
    throw new SnapshotFormatError(`${label}: missing "hourly"`);
  }
  const timesMs = parseTimes(hourly[RESPONSE.time], `${label} hourly`);
  const suffix = OPEN_METEO_SOURCES[source].variableSuffix;
  const values: Partial<Record<WeatherVariable, (number | null)[]>> = {};
  for (const variable of SOURCE_VARIABLES[source]) {
    values[variable] = parseNumberColumn(
      hourly[`${variable}${suffix}`],
      timesMs.length,
      `${label} ${variable}`,
    );
  }

  const sunsetMsByDate: Record<string, number> = {};
  if (OPEN_METEO_SOURCES[source].includesDaily) {
    const daily = json[RESPONSE.daily];
    if (!isRecord(daily)) {
      throw new SnapshotFormatError(`${label}: missing "daily"`);
    }
    const dayTimes = parseTimes(daily[RESPONSE.time], `${label} daily`);
    const sunsets = parseNumberColumn(
      daily[DAILY_VARIABLE_SUNSET],
      dayTimes.length,
      `${label} sunset`,
    );
    dayTimes.forEach((dayMs, position) => {
      const sunsetSeconds = sunsets[position];
      if (sunsetSeconds !== null && sunsetSeconds !== undefined) {
        sunsetMsByDate[madridDateOf(dayMs)] = sunsetSeconds * 1000;
      }
    });
  }
  return { timesMs, values, sunsetMsByDate };
}

function mergeChunks(
  source: SnapshotSourceKey,
  chunks: readonly ParsedChunk[],
): { series: HourlySeries; sunsetMsByDate: Record<string, number> } {
  const rows = new Map<number, Partial<Record<WeatherVariable, number | null>>>();
  const sunsetMsByDate: Record<string, number> = {};
  for (const chunk of chunks) {
    chunk.timesMs.forEach((timeMs, position) => {
      if (rows.has(timeMs)) {
        return;
      }
      const row: Partial<Record<WeatherVariable, number | null>> = {};
      for (const variable of SOURCE_VARIABLES[source]) {
        row[variable] = chunk.values[variable]?.[position] ?? null;
      }
      rows.set(timeMs, row);
    });
    Object.assign(sunsetMsByDate, chunk.sunsetMsByDate);
  }
  const timesMs = [...rows.keys()].sort((a, b) => a - b);
  const values: Partial<Record<WeatherVariable, (number | null)[]>> = {};
  for (const variable of SOURCE_VARIABLES[source]) {
    values[variable] = timesMs.map((timeMs) => rows.get(timeMs)?.[variable] ?? null);
  }
  const sortedSunsets: Record<string, number> = {};
  for (const date of Object.keys(sunsetMsByDate).sort()) {
    sortedSunsets[date] = sunsetMsByDate[date] ?? 0;
  }
  return { series: { timesMs, values }, sunsetMsByDate: sortedSunsets };
}

/** Variables that must be present for a day to count as a complete archive day. */
const CORE_ARCHIVE_VARIABLES: readonly WeatherVariable[] = [
  "temperature_2m",
  "dew_point_2m",
  "relative_humidity_2m",
  "precipitation",
  "wind_speed_10m",
  "sunshine_duration",
];

/** 23, 24 or 25 across the DST changes. */
function hoursInMadridDay(date: string): number {
  const start = madridWallTimeToEpochMs(date, "00:00");
  const end = madridWallTimeToEpochMs(addDays(date, 1), "00:00");
  return Math.round((end - start) / HOUR_MS);
}

/**
 * The archive's last complete day: the latest Madrid date, from `startDate` on, with all 24
 * hours present and every core variable non-null. ET0 is not required (the plants label has a
 * labelled fallback). Returns undefined if no day is complete.
 */
export function archiveLastCompleteDay(
  archive: HourlySeries,
  startDate: string,
  requestedEndDate: string,
): string | undefined {
  const hoursByDay = new Map<string, number>();
  archive.timesMs.forEach((timeMs, position) => {
    const core = CORE_ARCHIVE_VARIABLES.every(
      (variable) => archive.values[variable]?.[position] != null,
    );
    if (core) {
      const date = madridDateOf(timeMs);
      hoursByDay.set(date, (hoursByDay.get(date) ?? 0) + 1);
    }
  });
  const complete = new Set<string>();
  for (const [date, count] of hoursByDay) {
    if (count === hoursInMadridDay(date)) {
      complete.add(date);
    }
  }
  let last: string | undefined;
  for (const date of dateRange(startDate, requestedEndDate)) {
    if (complete.has(date)) {
      last = date;
    }
  }
  return last;
}

/**
 * Fetches the three sources for the location and builds the snapshot. Deterministic given the
 * responses: months are fetched in order, merged by time, sorted.
 */
export async function fetchSnapshot(params: FetchSnapshotParams): Promise<WeatherSnapshot> {
  const { fetchJson, location, startDate, requestedEndDate, fetchedAt } = params;
  if (requestedEndDate < startDate) {
    throw new Error("requestedEndDate is before startDate");
  }
  const roundedLocation: SnapshotLocation = {
    name: location.name,
    latitude: roundCoordinate(location.latitude),
    longitude: roundCoordinate(location.longitude),
  };

  const merged = {} as Record<
    SnapshotSourceKey,
    { series: HourlySeries; sunsetMsByDate: Record<string, number> }
  >;
  const sourceKeys = Object.keys(OPEN_METEO_SOURCES) as SnapshotSourceKey[];
  for (const source of sourceKeys) {
    const chunks: ParsedChunk[] = [];
    for (const chunk of monthChunks(startDate, requestedEndDate)) {
      const url = buildRequestUrl(source, roundedLocation, chunk);
      assertAllowedUrl(url);
      chunks.push(parseOpenMeteoResponse(await fetchJson(url), source));
    }
    merged[source] = mergeChunks(source, chunks);
  }

  const endDate = archiveLastCompleteDay(merged.archive.series, startDate, requestedEndDate);
  if (endDate === undefined) {
    throw new Error("the archive has no complete day in the requested range");
  }

  const sources = {} as Record<
    SnapshotSourceKey,
    { baseUrl: string; variables: readonly string[] }
  >;
  for (const source of sourceKeys) {
    const spec = OPEN_METEO_SOURCES[source];
    sources[source] = {
      baseUrl: spec.baseUrl,
      variables: SOURCE_VARIABLES[source].map((variable) => `${variable}${spec.variableSuffix}`),
    };
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    attribution: ATTRIBUTION,
    license: LICENSE,
    location: roundedLocation,
    timeZone: QUERY.timezoneValue,
    startDate,
    endDate,
    requestedEndDate,
    fetchedAt,
    sources,
    previousRunsDay1: merged.previousRunsDay1.series,
    historicalForecast: merged.historicalForecast.series,
    archive: merged.archive.series,
    sunsetMsByDate: merged.archive.sunsetMsByDate,
  };
}

// ---------------------------------------------------------------------------------------------
// Persistence (byte-stable) and validation
// ---------------------------------------------------------------------------------------------

export function serializeSnapshot(snapshot: WeatherSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

export function snapshotDirectoryName(snapshot: WeatherSnapshot): string {
  const slug = snapshot.location.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}_${snapshot.startDate}_${snapshot.endDate}`;
}

function snapshotReadme(snapshot: WeatherSnapshot): string {
  return [
    `# Weather snapshot: ${snapshot.location.name}`,
    "",
    snapshot.attribution,
    "",
    `- Days: ${snapshot.startDate} to ${snapshot.endDate} (the archive's last complete day), Europe/Madrid`,
    `- Requested end date: ${snapshot.requestedEndDate}; fetched at ${snapshot.fetchedAt}`,
    `- Location: ${snapshot.location.latitude}, ${snapshot.location.longitude} (rounded to 2 decimals)`,
    `- Sources: ${Object.values(snapshot.sources)
      .map((source) => source.baseUrl)
      .join(", ")}`,
    "",
    `\`${SNAPSHOT_FILE_NAME}\` is the input of the backtest and the fine-tune dataset;`,
    "re-running them from this file reproduces the same output.",
    "",
  ].join("\n");
}

/** Writes `<root>/<name>/snapshot.json` and a README with the attribution. Returns the dir. */
export async function writeSnapshot(root: string, snapshot: WeatherSnapshot): Promise<string> {
  const directory = join(root, snapshotDirectoryName(snapshot));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, SNAPSHOT_FILE_NAME), serializeSnapshot(snapshot));
  await writeFile(join(directory, "README.md"), snapshotReadme(snapshot));
  return directory;
}

export async function readSnapshot(directory: string): Promise<WeatherSnapshot> {
  const text = await readFile(join(directory, SNAPSHOT_FILE_NAME), "utf8");
  return parseSnapshot(JSON.parse(text) as unknown);
}

function expectString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new SnapshotFormatError(`snapshot.${key} must be a string`);
  }
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SnapshotFormatError(`${label} must be an object`);
  }
  return value;
}

function parseSeries(value: unknown, label: string): HourlySeries {
  const record = expectRecord(value, label);
  const times = record["timesMs"];
  if (!Array.isArray(times)) {
    throw new SnapshotFormatError(`${label}.timesMs must be an array`);
  }
  const timesMs = times.map((time: unknown) => {
    if (typeof time !== "number" || !Number.isFinite(time) || time % HOUR_MS !== 0) {
      throw new SnapshotFormatError(`${label}.timesMs must be whole-hour epoch milliseconds`);
    }
    return time;
  });
  for (let position = 1; position < timesMs.length; position += 1) {
    if ((timesMs[position] ?? 0) <= (timesMs[position - 1] ?? 0)) {
      throw new SnapshotFormatError(`${label}.timesMs must be strictly ascending`);
    }
  }
  const rawValues = expectRecord(record["values"], `${label}.values`);
  const values: Partial<Record<WeatherVariable, (number | null)[]>> = {};
  for (const variable of WEATHER_VARIABLES) {
    if (rawValues[variable] !== undefined) {
      values[variable] = parseNumberColumn(
        rawValues[variable],
        timesMs.length,
        `${label}.values.${variable}`,
      );
    }
  }
  return { timesMs, values };
}

/** Validates snapshot JSON read from disk. */
export function parseSnapshot(json: unknown): WeatherSnapshot {
  const record = expectRecord(json, "snapshot");
  if (record["schemaVersion"] !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotFormatError(`unsupported schemaVersion ${String(record["schemaVersion"])}`);
  }
  const location = expectRecord(record["location"], "snapshot.location");
  const latitude = location["latitude"];
  const longitude = location["longitude"];
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    throw new SnapshotFormatError("snapshot.location needs numeric latitude and longitude");
  }
  const sunsetsRaw = expectRecord(record["sunsetMsByDate"], "snapshot.sunsetMsByDate");
  const sunsetMsByDate: Record<string, number> = {};
  for (const [date, sunset] of Object.entries(sunsetsRaw)) {
    if (typeof sunset !== "number" || !Number.isFinite(sunset)) {
      throw new SnapshotFormatError("snapshot.sunsetMsByDate values must be numbers");
    }
    sunsetMsByDate[date] = sunset;
  }
  const sourcesRaw = expectRecord(record["sources"], "snapshot.sources");
  const sources = {} as Record<
    SnapshotSourceKey,
    { baseUrl: string; variables: readonly string[] }
  >;
  for (const key of Object.keys(OPEN_METEO_SOURCES) as SnapshotSourceKey[]) {
    const entry = expectRecord(sourcesRaw[key], `snapshot.sources.${key}`);
    const variables = entry["variables"];
    if (!Array.isArray(variables) || !variables.every((v) => typeof v === "string")) {
      throw new SnapshotFormatError(`snapshot.sources.${key}.variables must be strings`);
    }
    sources[key] = {
      baseUrl: expectString(entry, "baseUrl"),
      variables: variables,
    };
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    attribution: expectString(record, "attribution"),
    license: expectString(record, "license"),
    location: { name: expectString(location, "name"), latitude, longitude },
    timeZone: expectString(record, "timeZone"),
    startDate: expectString(record, "startDate"),
    endDate: expectString(record, "endDate"),
    requestedEndDate: expectString(record, "requestedEndDate"),
    fetchedAt: expectString(record, "fetchedAt"),
    sources,
    previousRunsDay1: parseSeries(record["previousRunsDay1"], "snapshot.previousRunsDay1"),
    historicalForecast: parseSeries(record["historicalForecast"], "snapshot.historicalForecast"),
    archive: parseSeries(record["archive"], "snapshot.archive"),
    sunsetMsByDate,
  };
}
