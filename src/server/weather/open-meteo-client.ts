import { roundCoordinate } from "../../domain/open-meteo.js";
import { windowHourStarts, type HourlyWeather } from "../../domain/outcomes.js";
import { HOUR_MS, madridDateOf } from "../../domain/time.js";
import type { Db } from "../db.js";

import { WeatherCache, PersistentCallCounter } from "./cache.js";
import {
  FORECAST_MAX_AGE_MS,
  FORECAST_TTL_MS,
  WeatherUnavailableError,
  type Forecast,
  type RecordedWeather,
  type WeatherClient,
} from "./client.js";
import { OpenMeteoHttp, type CallLogEntry } from "./http.js";
import {
  DAILY_VARIABLES,
  FORECAST_DAYS,
  FORECAST_PAST_DAYS,
  FORECAST_URL,
  HOURLY_VARIABLES,
  QUERY,
} from "./open-meteo.js";
import {
  OpenMeteoFormatError,
  REQUIRED_FOR_SETTLEMENT,
  type HourlyTable,
  forecastHours,
  parseHourlyTable,
  parseSunsets,
  recordedHours,
} from "./parse.js";

/** A complete recorded window is reused for 1 h; an incomplete one is never cached. */
export const RECORDED_TTL_MS = 60 * 60 * 1000;

/** A parsed forecast answer with the time it was fetched. */
interface CachedTable {
  readonly fetchedAt: number;
  readonly table: HourlyTable;
  readonly sunsetMsByDate: Readonly<Record<string, number>>;
  readonly sunsetFallbackDates: readonly string[];
}

/** Where the household is, from `config/household.json` (rounded again here, before any request). */
export interface Location {
  readonly latitude: number;
  readonly longitude: number;
}

export interface OpenMeteoClientOptions {
  readonly db: Db;
  readonly now: () => number;
  readonly location: Location;
  /** The HTTP layer; tests inject a transport that reaches a fake server. */
  readonly http?: OpenMeteoHttp;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly log?: (entry: CallLogEntry) => void;
  /**
   * Ask for the daily sunset (laundry tonight). Off: the forecast request is exactly what it was
   * before the feature existed, and a sunset comes from the daylight hours alone.
   */
  readonly requestSunset?: boolean;
  /** Days of forecast to ask for; the laundry planner needs four (default: `FORECAST_DAYS`). */
  readonly forecastDays?: number;
}

/**
 * The live weather client (design.md, Weather service): Open-Meteo forecast for the odds, its
 * past hours for settlement, a 1 h cache in SQLite, the latest cached forecast when Open-Meteo is
 * unreachable (AC-014.3), and no forecast at all once the cache is 24 h old (AC-014.4).
 * Coordinates come from config and are rounded to 2 decimals (AC-014.1); the model never chooses
 * the location.
 */
export class OpenMeteoWeatherClient implements WeatherClient {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly latitude: number;
  private readonly longitude: number;
  private readonly requestSunset: boolean;
  private readonly forecastDays: number;
  private readonly http: OpenMeteoHttp;
  private readonly cache: WeatherCache;
  readonly calls: PersistentCallCounter;
  /** Requests in flight by cache key: concurrent cards share one call. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: OpenMeteoClientOptions) {
    this.db = options.db;
    this.now = options.now;
    this.latitude = roundCoordinate(options.location.latitude);
    this.longitude = roundCoordinate(options.location.longitude);
    this.requestSunset = options.requestSunset ?? false;
    this.forecastDays = options.forecastDays ?? FORECAST_DAYS;
    this.cache = new WeatherCache(options.db);
    this.calls = new PersistentCallCounter(options.db, options.now);
    this.http =
      options.http ??
      new OpenMeteoHttp({
        counter: this.calls,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.random === undefined ? {} : { random: options.random }),
        ...(options.log === undefined ? {} : { log: options.log }),
      });
  }

  private get coordinates(): string {
    return `${this.latitude}|${this.longitude}`;
  }

  private forecastKey(): string {
    return `forecast|${this.coordinates}|${FORECAST_PAST_DAYS}p${this.forecastDays}d`;
  }

  private recordedKey(startDate: string, endDate: string): string {
    return `recorded|${this.coordinates}|${startDate}|${endDate}`;
  }

  private url(range: Record<string, string>, daily = false): string {
    const params = new URLSearchParams();
    params.set(QUERY.latitude, String(this.latitude));
    params.set(QUERY.longitude, String(this.longitude));
    params.set(QUERY.hourly, Object.values(HOURLY_VARIABLES).join(","));
    if (daily) {
      params.set(QUERY.daily, Object.values(DAILY_VARIABLES).join(","));
    }
    for (const [name, value] of Object.entries(range)) {
      params.set(name, value);
    }
    params.set(QUERY.timezone, QUERY.timezoneValue);
    params.set(QUERY.timeFormat, QUERY.timeFormatValue);
    return `${FORECAST_URL}?${params.toString()}`;
  }

  private shared<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      return running as Promise<T>;
    }
    const started = load().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }

  /**
   * A cache entry that still parses. An entry that does not (a corrupt row, an answer shape this
   * version cannot read) counts as a miss: it is fetched again, never a raw error.
   */
  private readable(key: string): CachedTable | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return undefined;
    }
    try {
      const table = parseHourlyTable(entry.body);
      const { sunsets, fallbackDates } = parseSunsets(entry.body, forecastHours(table));
      return {
        fetchedAt: entry.fetchedAt,
        table,
        sunsetMsByDate: sunsets,
        sunsetFallbackDates: fallbackDates,
      };
    } catch (error) {
      if (error instanceof OpenMeteoFormatError) {
        return undefined;
      }
      throw error;
    }
  }

  latestForecastFetchedAt(): number | undefined {
    const entry = this.readable(this.forecastKey());
    return entry !== undefined && this.now() - entry.fetchedAt < FORECAST_MAX_AGE_MS
      ? entry.fetchedAt
      : undefined;
  }

  latestForecast(): Forecast | undefined {
    const entry = this.readable(this.forecastKey());
    if (entry === undefined || this.now() - entry.fetchedAt >= FORECAST_MAX_AGE_MS) {
      return undefined;
    }
    return {
      fetchedAt: entry.fetchedAt,
      hours: forecastHours(entry.table),
      sunsetMsByDate: entry.sunsetMsByDate,
      sunsetFallbackDates: entry.sunsetFallbackDates,
    };
  }

  async getForecast(request: {
    fromMs: number;
    hours: number;
    pastHours?: number;
  }): Promise<Forecast> {
    const pastHours = request.pastHours ?? 0;
    const { fetchedAt, table, sunsetMsByDate, sunsetFallbackDates } = await this.forecastTable();
    const firstHour = Math.floor(request.fromMs / HOUR_MS) * HOUR_MS - pastHours * HOUR_MS;
    const hours = forecastHours(table)
      .filter((hour) => hour.startsAt >= firstHour)
      .slice(0, pastHours + request.hours);
    return { fetchedAt, hours, sunsetMsByDate, sunsetFallbackDates };
  }

  /** Cached table younger than 1 h, else a fresh fetch, else the cache if it is under 24 h old. */
  private async forecastTable(): Promise<CachedTable> {
    const key = this.forecastKey();
    const cached = this.readable(key);
    if (cached !== undefined && this.now() - cached.fetchedAt < FORECAST_TTL_MS) {
      return cached;
    }
    try {
      return await this.shared(key, async () => {
        const body = await this.http.getJson(
          this.url(
            {
              [QUERY.forecastDays]: String(this.forecastDays),
              [QUERY.pastDays]: String(FORECAST_PAST_DAYS),
            },
            this.requestSunset,
          ),
        );
        // Refuse an answer the app cannot read before it replaces a good cache entry.
        const table = parseHourlyTable(body);
        const fetchedAt = this.now();
        this.cache.put(key, fetchedAt, body);
        const { sunsets, fallbackDates } = parseSunsets(body, forecastHours(table));
        return {
          fetchedAt,
          table,
          sunsetMsByDate: sunsets,
          sunsetFallbackDates: fallbackDates,
        };
      });
    } catch (error) {
      if (cached !== undefined && this.now() - cached.fetchedAt < FORECAST_MAX_AGE_MS) {
        return cached;
      }
      throw asUnavailable(error);
    }
  }

  async getRecorded(request: { fromMs: number; toMs: number }): Promise<RecordedWeather> {
    const startDate = madridDateOf(request.fromMs);
    const endDate = madridDateOf(Math.max(request.fromMs, request.toMs - 1));
    const key = this.recordedKey(startDate, endDate);
    const cached = this.readable(key);
    if (cached !== undefined && this.now() - cached.fetchedAt < RECORDED_TTL_MS) {
      return this.recordedFrom(cached.fetchedAt, cached.table, request);
    }
    try {
      const { fetchedAt, body, table } = await this.shared(key, async () => {
        const answer = await this.http.getJson(
          this.url({ [QUERY.startDate]: startDate, [QUERY.endDate]: endDate }),
        );
        return { fetchedAt: this.now(), body: answer, table: parseHourlyTable(answer) };
      });
      const recorded = this.recordedFrom(fetchedAt, table, request);
      if (recorded.complete) {
        this.cache.put(key, fetchedAt, body);
      }
      return recorded;
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  private recordedFrom(
    fetchedAt: number,
    table: HourlyTable,
    request: { fromMs: number; toMs: number },
  ): RecordedWeather {
    const byHour = new Map(recordedHours(table).map((hour) => [hour.timeMs, hour]));
    const wanted = windowHourStarts({ startMs: request.fromMs, endMs: request.toMs });
    const hours = wanted.flatMap((start) => byHour.get(start) ?? []);
    const complete =
      hours.length === wanted.length && hours.every((hour) => hasSettlementValues(hour));
    return { fetchedAt, complete, hours };
  }
}

function hasSettlementValues(hour: HourlyWeather): boolean {
  return REQUIRED_FOR_SETTLEMENT.every((field) => hour[field] !== null);
}

function asUnavailable(error: unknown): Error {
  if (error instanceof WeatherUnavailableError) {
    return error;
  }
  if (error instanceof OpenMeteoFormatError) {
    return new WeatherUnavailableError(error.message);
  }
  return error instanceof Error ? error : new WeatherUnavailableError("weather lookup failed");
}
