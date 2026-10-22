import { madridDateOf } from "../../domain/time.js";
import type { Db } from "../db.js";

import { WeatherUnavailableError } from "./client.js";
import { DAILY_CALL_BUDGET, type CallCounter } from "./http.js";

export interface CacheEntry {
  readonly key: string;
  readonly fetchedAt: number;
  /** The Open-Meteo answer, as the JSON it came in. */
  readonly body: unknown;
}

interface CacheRow {
  key: string;
  fetched_at: number;
  body: string;
}

/**
 * The `weather_cache` table (design.md, Data model): one row per request key
 * (endpoint, rounded coordinates, range) with the time it was fetched.
 */
export class WeatherCache {
  constructor(private readonly db: Db) {}

  get(key: string): CacheEntry | undefined {
    const row = this.db
      .prepare<[string], CacheRow>("SELECT key, fetched_at, body FROM weather_cache WHERE key = ?")
      .get(key);
    if (row === undefined) {
      return undefined;
    }
    try {
      return { key: row.key, fetchedAt: row.fetched_at, body: JSON.parse(row.body) as unknown };
    } catch {
      return undefined;
    }
  }

  put(key: string, fetchedAt: number, body: unknown): void {
    this.db
      .prepare(
        `INSERT INTO weather_cache (key, fetched_at, body) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body`,
      )
      .run(key, fetchedAt, JSON.stringify(body));
  }

  /** The newest entry whose key starts with `prefix`. */
  newest(prefix: string): CacheEntry | undefined {
    const row = this.db
      .prepare<[string], CacheRow>(
        `SELECT key, fetched_at, body FROM weather_cache
         WHERE substr(key, 1, length(?1)) = ?1 ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(prefix);
    return row === undefined ? undefined : this.get(row.key);
  }
}

/**
 * Open-Meteo calls per Madrid day, kept in `weather_cache` (row `calls|YYYY-MM-DD`) so the count
 * survives a restart and shows up next to the weather it paid for (NFR-006).
 */
export class PersistentCallCounter implements CallCounter {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly budget: number = DAILY_CALL_BUDGET,
  ) {}

  countToday(): number {
    const row = this.db
      .prepare<[string], { body: string }>("SELECT body FROM weather_cache WHERE key = ?")
      .get(this.key());
    return row === undefined ? 0 : (JSON.parse(row.body) as { count: number }).count;
  }

  take(): number {
    const count = this.countToday();
    if (count >= this.budget) {
      throw new WeatherUnavailableError(
        `the daily budget of ${this.budget} Open-Meteo calls is used up`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO weather_cache (key, fetched_at, body) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body`,
      )
      .run(this.key(), this.now(), JSON.stringify({ count: count + 1 }));
    return count + 1;
  }

  private key(): string {
    return `calls|${madridDateOf(this.now())}`;
  }
}
