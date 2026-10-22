import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DisallowedHostError,
  OPEN_METEO_ALLOWED_HOSTS,
  OPEN_METEO_HOSTS,
  roundCoordinate,
} from "../src/domain/open-meteo.js";
import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { PersistentCallCounter } from "../src/server/weather/cache.js";
import {
  FORECAST_MAX_AGE_MS,
  FORECAST_TTL_MS,
  WeatherUnavailableError,
} from "../src/server/weather/client.js";
import { OpenMeteoHttp, type CallLogEntry } from "../src/server/weather/http.js";
import { OpenMeteoWeatherClient } from "../src/server/weather/open-meteo-client.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";
import { ALLOWED_HOSTS } from "../src/backtest/open-meteo.js";

import { FakeClock } from "./helpers.js";
import { FakeOpenMeteo } from "./support/fake-open-meteo.js";

const HOUR = 3_600_000;
const GRACIA = { latitude: 41.4012, longitude: 2.1587 };

let db: Db;
let clock: FakeClock;
let server: FakeOpenMeteo;
let sleeps: number[];
let log: CallLogEntry[];

beforeEach(async () => {
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS);
  clock = new FakeClock();
  server = new FakeOpenMeteo(clock.now);
  await server.start();
  sleeps = [];
  log = [];
});

afterEach(async () => {
  await server.stop();
  db.close();
});

function client(overrides: Partial<ConstructorParameters<typeof OpenMeteoWeatherClient>[0]> = {}) {
  return new OpenMeteoWeatherClient({
    db,
    now: clock.now,
    location: GRACIA,
    fetch: server.transport,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    log: (entry) => log.push(entry),
    ...overrides,
  });
}

describe("AC-014.1: the forecast is requested for the configured coordinates, rounded to 2 decimals", () => {
  it("rounds latitude and longitude before the request and asks the forecast host", async () => {
    await client().getForecast({ fromMs: clock.now(), hours: 48 });
    const url = server.requests[0]!;
    expect(url.searchParams.get("latitude")).toBe("41.4");
    expect(url.searchParams.get("longitude")).toBe("2.16");
    expect(url.pathname).toBe("/v1/forecast");
    expect(server.hostsSeen).toEqual([OPEN_METEO_HOSTS.forecast]);
    // Nothing else about the household is in the request.
    expect([...url.searchParams.keys()].sort()).toEqual([
      "forecast_days",
      "hourly",
      "latitude",
      "longitude",
      "timeformat",
      "timezone",
    ]);
  });

  it("rounds to 2 decimals, west and south too", () => {
    expect(roundCoordinate(41.4012)).toBe(41.4);
    expect(roundCoordinate(2.1587)).toBe(2.16);
    expect(roundCoordinate(-2.1587)).toBe(-2.16);
  });

  it("returns the hours from the one containing the start, as many as asked", async () => {
    const forecast = await client().getForecast({ fromMs: clock.now() + 20 * 60_000, hours: 48 });
    expect(forecast.hours).toHaveLength(48);
    expect(forecast.hours[0]?.startsAt).toBe(clock.now()); // 10:00 Madrid, hour of 10:20
    expect(forecast.fetchedAt).toBe(clock.now());
  });
});

describe("AC-014.2: a fetched forecast is cached with its fetch time and reused for at most 1 h", () => {
  it("serves the cache for 59 minutes and fetches again at 60", async () => {
    const weather = client();
    await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    clock.advance(59 * 60_000);
    const cached = await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    expect(server.forecastRequests).toHaveLength(1);
    expect(cached.fetchedAt).toBe(clock.now() - 59 * 60_000);

    clock.advance(60_000);
    const fresh = await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    expect(server.forecastRequests).toHaveLength(2);
    expect(fresh.fetchedAt).toBe(clock.now());
  });

  it("keeps the cache in weather_cache, so a restart reuses it", async () => {
    await client().getForecast({ fromMs: clock.now(), hours: 24 });
    const row = db
      .prepare<[], { key: string; fetched_at: number }>(
        "SELECT key, fetched_at FROM weather_cache WHERE key LIKE 'forecast|%'",
      )
      .get();
    expect(row).toEqual({ key: "forecast|41.4|2.16|3d", fetched_at: clock.now() });
    await client().getForecast({ fromMs: clock.now(), hours: 24 }); // a new client, same database
    expect(server.forecastRequests).toHaveLength(1);
  });

  it("shares one request between cards created at the same moment", async () => {
    const weather = client();
    await Promise.all([
      weather.getForecast({ fromMs: clock.now(), hours: 24 }),
      weather.getForecast({ fromMs: clock.now(), hours: 48 }),
    ]);
    expect(server.forecastRequests).toHaveLength(1);
  });
});

describe("AC-014.3 and AC-014.4: Open-Meteo unreachable", () => {
  it("AC-014.3: uses the latest cached forecast and reports when it was fetched", async () => {
    const weather = client();
    await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    const fetchedAt = clock.now();
    clock.advance(3 * HOUR);
    server.mode = "http-500";
    const stale = await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    expect(stale.fetchedAt).toBe(fetchedAt);
    expect(clock.now() - stale.fetchedAt).toBe(3 * HOUR);
    expect(weather.latestForecastFetchedAt()).toBe(fetchedAt);
  });

  it("AC-014.4: with no cache at all there is no forecast", async () => {
    server.mode = "http-500";
    await expect(client().getForecast({ fromMs: clock.now(), hours: 24 })).rejects.toBeInstanceOf(
      WeatherUnavailableError,
    );
  });

  it("AC-014.4: a cache just under 24 h old is used, one 24 h old is not", async () => {
    const weather = client();
    await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    server.mode = "http-500";
    clock.advance(FORECAST_MAX_AGE_MS - 1);
    await expect(weather.getForecast({ fromMs: clock.now(), hours: 24 })).resolves.toBeDefined();
    expect(weather.latestForecastFetchedAt()).toBeDefined();
    clock.advance(1);
    await expect(weather.getForecast({ fromMs: clock.now(), hours: 24 })).rejects.toBeInstanceOf(
      WeatherUnavailableError,
    );
    expect(weather.latestForecastFetchedAt()).toBeUndefined();
  });

  it("a page that is not JSON never replaces a good cache entry", async () => {
    const weather = client();
    await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    clock.advance(2 * HOUR);
    server.mode = "not-json";
    const forecast = await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    expect(forecast.fetchedAt).toBe(clock.now() - 2 * HOUR);
  });

  it("an answer in the wrong shape is refused", async () => {
    const http = new OpenMeteoHttp({
      counter: new PersistentCallCounter(db, clock.now),
      fetch: () => Promise.resolve(Response.json({ hourly: { time: ["x"] } })),
    });
    const weather = new OpenMeteoWeatherClient({ db, now: clock.now, location: GRACIA, http });
    await expect(weather.getForecast({ fromMs: clock.now(), hours: 24 })).rejects.toBeInstanceOf(
      WeatherUnavailableError,
    );
  });
});

describe("timeout, retry with backoff and jitter, redirects", () => {
  it("retries a failing request and succeeds on the third try, backing off with jitter", async () => {
    server.failFirst = 2;
    const forecast = await client().getForecast({ fromMs: clock.now(), hours: 24 });
    expect(forecast.hours).toHaveLength(24);
    expect(server.requests).toHaveLength(3);
    // 200 ms then 400 ms, each plus jitter (random() = 0.5 of 100 ms).
    expect(sleeps).toEqual([250, 450]);
  });

  it("gives up after three tries", async () => {
    server.mode = "http-500";
    await expect(client().getForecast({ fromMs: clock.now(), hours: 24 })).rejects.toThrow(/500/);
    expect(server.requests).toHaveLength(3);
  });

  it("does not retry a 404: the same request would fail the same way", async () => {
    server.mode = "http-404";
    await expect(client().getForecast({ fromMs: clock.now(), hours: 24 })).rejects.toThrow(/404/);
    expect(server.requests).toHaveLength(1);
  });

  it("times out a request that never answers (fetch timeout, AC-004.1)", async () => {
    server.mode = "hang";
    const http = new OpenMeteoHttp({
      counter: new PersistentCallCounter(db, clock.now),
      fetch: server.transport,
      sleep: () => Promise.resolve(),
      attemptTimeoutMs: 40,
      deadlineMs: 120,
    });
    const weather = new OpenMeteoWeatherClient({ db, now: clock.now, location: GRACIA, http });
    const started = Date.now();
    await expect(weather.getForecast({ fromMs: clock.now(), hours: 24 })).rejects.toBeInstanceOf(
      WeatherUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("AC-014.7: a redirect is an error and is never followed to another host", async () => {
    server.mode = "redirect";
    await expect(client().getForecast({ fromMs: clock.now(), hours: 24 })).rejects.toBeInstanceOf(
      WeatherUnavailableError,
    );
    expect(server.requests).toHaveLength(1); // not retried
    expect(server.hostsSeen).toEqual([OPEN_METEO_HOSTS.forecast]); // evil.example never contacted
  });
});

describe("AC-014.7: only the Open-Meteo hosts of the allowlist are called", () => {
  const http = (): OpenMeteoHttp =>
    new OpenMeteoHttp({
      counter: new PersistentCallCounter(db, clock.now),
      fetch: server.transport,
      sleep: () => Promise.resolve(),
    });

  it("the allowlist is the four hosts of the design", () => {
    expect([...OPEN_METEO_ALLOWED_HOSTS].sort()).toEqual([
      "api.open-meteo.com",
      "archive-api.open-meteo.com",
      "historical-forecast-api.open-meteo.com",
      "previous-runs-api.open-meteo.com",
    ]);
  });

  it.each(OPEN_METEO_ALLOWED_HOSTS)("accepts %s", async (host) => {
    await expect(http().getJson(`https://${host}/v1/forecast?latitude=1`)).resolves.toBeDefined();
    expect(server.hostsSeen).toEqual([host]);
  });

  it.each([
    "https://example.com/v1/forecast",
    "https://evil.example/https://api.open-meteo.com/v1/forecast",
    "http://api.open-meteo.com/v1/forecast",
    "https://api.open-meteo.com.evil.example/v1/forecast",
    "https://api.open-meteo.com@evil.example/v1/forecast",
    "https://u:p@api.open-meteo.com/v1/forecast",
    "https://api.open-meteo.com:8443/v1/forecast",
    "https://open-meteo.com/",
    "https://geocoding-api.open-meteo.com/v1/search",
    "https://127.0.0.1:11434/api/chat",
    "file:///etc/passwd",
  ])("refuses %s before any request, and spends no budget", async (url) => {
    await expect(http().getJson(url)).rejects.toBeInstanceOf(DisallowedHostError);
    expect(server.requests).toHaveLength(0);
    expect(server.hostsSeen).toHaveLength(0);
    expect(new PersistentCallCounter(db, clock.now).countToday()).toBe(0);
  });

  it("the snapshot's list of hosts is a subset of the client's, from the same definitions", () => {
    for (const host of ALLOWED_HOSTS) {
      expect(OPEN_METEO_ALLOWED_HOSTS).toContain(host);
    }
    expect(ALLOWED_HOSTS).not.toContain(OPEN_METEO_HOSTS.forecast);
  });
});

describe("NFR-006: calls are counted and logged, and the daily budget holds", () => {
  it("counts every request per Madrid day, across restarts, and logs it", async () => {
    server.failFirst = 1;
    await client().getForecast({ fromMs: clock.now(), hours: 24 });
    expect(log.map((entry) => [entry.attempt, entry.outcome, entry.callsToday])).toEqual([
      [1, "http-error", 1],
      [2, "ok", 2],
    ]);
    expect(log[1]).toMatchObject({ event: "open-meteo-call", host: "api.open-meteo.com" });
    expect(new PersistentCallCounter(db, clock.now).countToday()).toBe(2);
    clock.advance(24 * HOUR); // the next Madrid day starts again at 0
    expect(new PersistentCallCounter(db, clock.now).countToday()).toBe(0);
  });

  it("refuses to call once the day's budget is used", () => {
    const counter = new PersistentCallCounter(db, clock.now, 2);
    expect([counter.take(), counter.take()]).toEqual([1, 2]);
    expect(() => counter.take()).toThrow(WeatherUnavailableError);
  });

  it("falls back to the cache when the budget is spent", async () => {
    const weather = client();
    await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    db.prepare("UPDATE weather_cache SET body = ? WHERE key LIKE 'calls|%'").run(
      JSON.stringify({ count: 1000 }),
    );
    clock.advance(2 * HOUR);
    const forecast = await weather.getForecast({ fromMs: clock.now(), hours: 24 });
    expect(forecast.fetchedAt).toBe(clock.now() - 2 * HOUR);
    expect(server.forecastRequests).toHaveLength(1);
  });
});

describe("recorded weather for settlement (ADR-0008, AC-014.5)", () => {
  const window = () => ({ fromMs: clock.now() - 20 * HOUR, toMs: clock.now() - 2 * HOUR });

  it("asks the forecast API for the Madrid dates of the window and returns the window's hours", async () => {
    const recorded = await client().getRecorded(window());
    expect(recorded.complete).toBe(true);
    expect(recorded.hours).toHaveLength(18);
    expect(recorded.hours[0]?.timeMs).toBe(window().fromMs);
    const url = server.recordedRequests[0]!;
    expect(url.searchParams.get("start_date")).toBe("2026-10-21");
    expect(url.searchParams.get("end_date")).toBe("2026-10-22");
    expect(url.searchParams.get("latitude")).toBe("41.4");
  });

  it("is incomplete while the latest hours are not there yet, and is not cached", async () => {
    server.nullFromMs = window().toMs - 3 * HOUR;
    const weather = client();
    const first = await weather.getRecorded(window());
    expect(first.complete).toBe(false);
    await weather.getRecorded(window());
    expect(server.recordedRequests).toHaveLength(2); // asked again, nothing cached
    server.nullFromMs = undefined;
    expect((await weather.getRecorded(window())).complete).toBe(true);
  });

  it("caches a complete window for 1 h", async () => {
    const weather = client();
    await weather.getRecorded(window());
    clock.advance(FORECAST_TTL_MS - 1);
    await weather.getRecorded(window());
    expect(server.recordedRequests).toHaveLength(1);
    clock.advance(1);
    await weather.getRecorded(window());
    expect(server.recordedRequests).toHaveLength(2);
  });

  it("throws when Open-Meteo cannot be reached", async () => {
    server.mode = "http-500";
    await expect(client().getRecorded(window())).rejects.toBeInstanceOf(WeatherUnavailableError);
  });
});

describe("what the client reads out of an answer", () => {
  it("leaves an hour with a missing value out of the forecast, so a rule sees a hole", async () => {
    server.nullFromMs = clock.now() + 5 * HOUR;
    server.profile = FAKE_WEATHER_PROFILES.mild;
    const forecast = await client().getForecast({ fromMs: clock.now(), hours: 48 });
    expect(forecast.hours).toHaveLength(5);
  });
});
