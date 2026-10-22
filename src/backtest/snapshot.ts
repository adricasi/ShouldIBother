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
  assertIsoDate,
  dateRange,
  HOUR_MS,
  madridDateOf,
  madridWallTimeToEpochMs,
  type HourlyWeather,
} from "../domain/outcomes.js";
import {
  DisallowedHostError,
  assertAllowedUrl as assertAllowedHost,
  roundCoordinate,
} from "../domain/open-meteo.js";
import {
  ALLOWED_HOSTS,
  ATTRIBUTION,
  CORE_VARIABLES,
  DAILY_VARIABLE_SUNSET,
  LICENSE,
  OPEN_METEO_SOURCES,
  QUERY,
  REQUEST_TIMEOUT_MS,
  RESPONSE,
  SOURCE_VARIABLES,
  SUM_VARIABLES,
  SUM_VARIABLE_STAMP,
  WEATHER_VARIABLES,
  type HourStamp,
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

export interface SourceCoverage {
  readonly hours: number;
  readonly nonNull: Readonly<Partial<Record<WeatherVariable, number>>>;
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
  /** The hour-stamp convention assumed for sum variables; series are stored hour-start aligned. */
  readonly sumVariableStamp: HourStamp;
  /** Non-null value count per source and variable (for the manifest and for audits). */
  readonly coverage: Readonly<Record<SnapshotSourceKey, SourceCoverage>>;
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

/** A source that should provide a core variable returned nothing for it. */
export class SnapshotCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCoverageError";
  }
}

export { DisallowedHostError };

export type FetchJson = (url: string) => Promise<unknown>;

/** Open-Meteo's error body is `{"error": true, "reason": "..."}`. */
async function errorReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body["reason"] === "string") {
      return `: ${body["reason"]}`;
    }
  } catch {
    // not JSON: the status code is all we have
  }
  return "";
}

/**
 * Real fetch with a timeout, for the CLI (T-031). Redirects are an error, so a 3xx cannot
 * leave the allowlisted hosts. Tests inject a fake instead.
 */
export const fetchJsonWithTimeout: FetchJson = async (url) => {
  assertAllowedUrl(url);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `Open-Meteo answered ${response.status} for ${url}${await errorReason(response)}`,
    );
  }
  return await response.json();
};

/** The snapshot's allowlist: the three historical APIs (the forecast host is not among them). */
export function assertAllowedUrl(url: string): void {
  assertAllowedHost(url, ALLOWED_HOSTS);
}

// ---------------------------------------------------------------------------------------------
// Variable <-> HourlyWeather mapping
// ---------------------------------------------------------------------------------------------

/** Builds an `HourlyWeather` field by field from a per-variable lookup. */
export function hourlyWeatherFrom(
  timeMs: number,
  read: (variable: WeatherVariable) => number | null | undefined,
): HourlyWeather {
  return {
    timeMs,
    temperatureC: read("temperature_2m") ?? null,
    dewPointC: read("dew_point_2m") ?? null,
    relativeHumidityPct: read("relative_humidity_2m") ?? null,
    precipitationMm: read("precipitation") ?? null,
    precipitationProbabilityPct: read("precipitation_probability") ?? null,
    windSpeedKmh: read("wind_speed_10m") ?? null,
    windGustsKmh: read("wind_gusts_10m") ?? null,
    weatherCode: read("weather_code") ?? null,
    sunshineSeconds: read("sunshine_duration") ?? null,
    et0Mm: read("et0_fao_evapotranspiration") ?? null,
  };
}

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
  return snapshot.archive.timesMs.map((timeMs, position) =>
    hourlyWeatherFrom(timeMs, (variable) => snapshot.archive.values[variable]?.[position]),
  );
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
  /** Defaults to `SUM_VARIABLE_STAMP`; a parameter so tests can exercise both conventions. */
  readonly sumVariableStamp?: HourStamp;
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

/**
 * With "hour_end", a sum value stamped t covers the hour that started at t - 1 h: move it to
 * that hour. The series' last hour then has no sum value (null). Other variables are untouched.
 */
export function alignSumVariables(series: HourlySeries, stamp: HourStamp): HourlySeries {
  if (stamp === "hour_start") {
    return series;
  }
  const values: Partial<Record<WeatherVariable, (number | null)[]>> = {};
  for (const variable of WEATHER_VARIABLES) {
    const column = series.values[variable];
    if (column === undefined) {
      continue;
    }
    values[variable] = SUM_VARIABLES.includes(variable)
      ? column.map((_, position) => {
          const next = series.timesMs[position + 1];
          return next === (series.timesMs[position] ?? 0) + HOUR_MS
            ? (column[position + 1] ?? null)
            : null;
        })
      : [...column];
  }
  return { timesMs: series.timesMs, values };
}

/** Counts non-null values; throws if a core variable is entirely null for the source. */
export function coverageOf(series: HourlySeries, source: SnapshotSourceKey): SourceCoverage {
  const nonNull: Partial<Record<WeatherVariable, number>> = {};
  for (const variable of SOURCE_VARIABLES[source]) {
    nonNull[variable] = (series.values[variable] ?? []).filter((value) => value !== null).length;
  }
  for (const variable of CORE_VARIABLES) {
    if (SOURCE_VARIABLES[source].includes(variable) && nonNull[variable] === 0) {
      throw new SnapshotCoverageError(
        `${source} returned no values for ${variable}; check the variable name and the API`,
      );
    }
  }
  return { hours: series.timesMs.length, nonNull };
}

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
    const core = CORE_VARIABLES.every((variable) => archive.values[variable]?.[position] != null);
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
  const sumVariableStamp = params.sumVariableStamp ?? SUM_VARIABLE_STAMP;
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
    const combined = mergeChunks(source, chunks);
    merged[source] = {
      series: alignSumVariables(combined.series, sumVariableStamp),
      sunsetMsByDate: combined.sunsetMsByDate,
    };
  }

  const coverage = {} as Record<SnapshotSourceKey, SourceCoverage>;
  for (const source of sourceKeys) {
    coverage[source] = coverageOf(merged[source].series, source);
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
    sumVariableStamp,
    coverage,
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
    .replace(/\p{M}/gu, "")
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

function expectDate(record: Record<string, unknown>, key: string): string {
  const value = expectString(record, key);
  try {
    assertIsoDate(value);
  } catch (error) {
    throw new SnapshotFormatError(`snapshot.${key}: ${(error as Error).message}`);
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
    const baseUrl = expectString(entry, "baseUrl");
    try {
      assertAllowedUrl(baseUrl);
    } catch (error) {
      throw new SnapshotFormatError(
        `snapshot.sources.${key}.baseUrl is not allowed: ${(error as Error).message}`,
      );
    }
    sources[key] = { baseUrl, variables: variables };
  }

  const startDate = expectDate(record, "startDate");
  const endDate = expectDate(record, "endDate");
  const requestedEndDate = expectDate(record, "requestedEndDate");
  if (endDate < startDate) {
    throw new SnapshotFormatError("snapshot.endDate is before snapshot.startDate");
  }
  const timeZone = expectString(record, "timeZone");
  if (timeZone !== QUERY.timezoneValue) {
    throw new SnapshotFormatError(`snapshot.timeZone must be ${QUERY.timezoneValue}`);
  }
  const stamp = record["sumVariableStamp"];
  if (stamp !== "hour_start" && stamp !== "hour_end") {
    throw new SnapshotFormatError("snapshot.sumVariableStamp must be hour_start or hour_end");
  }
  const coverageRaw = expectRecord(record["coverage"], "snapshot.coverage");
  const coverage = {} as Record<SnapshotSourceKey, SourceCoverage>;
  for (const key of Object.keys(OPEN_METEO_SOURCES) as SnapshotSourceKey[]) {
    const entry = expectRecord(coverageRaw[key], `snapshot.coverage.${key}`);
    const hours = entry["hours"];
    if (typeof hours !== "number") {
      throw new SnapshotFormatError(`snapshot.coverage.${key}.hours must be a number`);
    }
    const counts = expectRecord(entry["nonNull"], `snapshot.coverage.${key}.nonNull`);
    const nonNull: Partial<Record<WeatherVariable, number>> = {};
    for (const [name, count] of Object.entries(counts)) {
      if (!(WEATHER_VARIABLES as readonly string[]).includes(name) || typeof count !== "number") {
        throw new SnapshotFormatError(`snapshot.coverage.${key}.nonNull has an invalid entry`);
      }
      nonNull[name as WeatherVariable] = count;
    }
    coverage[key] = { hours, nonNull };
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    attribution: expectString(record, "attribution"),
    license: expectString(record, "license"),
    location: { name: expectString(location, "name"), latitude, longitude },
    timeZone,
    startDate,
    endDate,
    requestedEndDate,
    fetchedAt: expectString(record, "fetchedAt"),
    sources,
    sumVariableStamp: stamp,
    coverage,
    previousRunsDay1: parseSeries(record["previousRunsDay1"], "snapshot.previousRunsDay1"),
    historicalForecast: parseSeries(record["historicalForecast"], "snapshot.historicalForecast"),
    archive: parseSeries(record["archive"], "snapshot.archive"),
    sunsetMsByDate,
  };
}
