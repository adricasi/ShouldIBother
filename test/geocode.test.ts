import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GEOCODE_MAX_RESULTS,
  languageFromAcceptLanguage,
  parseGeocodeQuery,
} from "../src/domain/geocode.js";
import { OPEN_METEO_HOSTS } from "../src/domain/open-meteo.js";
import { redactUrl, serializeRequest } from "../src/server/app.js";
import { SlidingWindowLimiter } from "../src/server/auth/rate-limit.js";
import type { Db } from "../src/server/db.js";
import { WeatherUnavailableError } from "../src/server/weather/client.js";
import { PersistentCallCounter } from "../src/server/weather/cache.js";
import { FakeGeocoder } from "../src/server/weather/fake-geocoder.js";
import {
  OpenMeteoGeocoder,
  geocodeUrl,
  parseGeocodeAnswer,
  type Geocoder,
} from "../src/server/weather/geocoding.js";
import { OpenMeteoHttp, type CallLogEntry } from "../src/server/weather/http.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { FakeOpenMeteo } from "./support/fake-open-meteo.js";

// A search text no other test value contains, so a leak into a log or a table is found by grep.
const SECRET_QUERY = "Zyxwvut Quarter";

let harness: CoreHarness | undefined;
let openMeteo: FakeOpenMeteo | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await openMeteo?.stop();
  openMeteo = undefined;
});

/** A harness whose geocoder is the real one, on a fake Open-Meteo server. */
async function setupLive(
  options: { flags?: { onboarding: boolean }; logLines?: string[]; callLog?: CallLogEntry[] } = {},
): Promise<{ harness: CoreHarness; openMeteo: FakeOpenMeteo }> {
  const server = new FakeOpenMeteo(Date.now);
  await server.start();
  openMeteo = server;
  // The call counter lives in the harness database, which exists only after the harness: the
  // geocoder reads it at the first search.
  const shared: { db?: Db } = {};
  const geocoder: Geocoder = {
    search: (query, language) =>
      new OpenMeteoGeocoder(
        new OpenMeteoHttp({
          counter: new PersistentCallCounter(shared.db!, Date.now),
          fetch: server.transport,
          sleep: () => Promise.resolve(),
          log: (entry) => options.callLog?.push(entry),
        }),
      ).search(query, language),
  };
  harness = await createCoreHarness({
    flags: options.flags ?? { onboarding: true },
    ...(options.logLines === undefined ? {} : { logLines: options.logLines }),
    geocoder,
  });
  shared.db = harness.db;
  await pair(harness);
  return { harness, openMeteo: server };
}

async function setup(
  geocoder: Geocoder,
  flags: { onboarding: boolean } = { onboarding: true },
  logLines?: string[],
): Promise<CoreHarness> {
  harness = await createCoreHarness({
    flags,
    geocoder,
    ...(logLines === undefined ? {} : { logLines }),
  });
  await pair(harness);
  return harness;
}

const search = (
  query: string,
  headers: Record<string, string> = {},
  target: CoreHarness | undefined = harness,
) =>
  target!.request({
    method: "GET",
    url: `/api/geocode?q=${encodeURIComponent(query)}`,
    headers: { cookie: target!.cookie, ...headers },
  });

const GRACIA = {
  name: "Gràcia",
  admin1: "Barcelona",
  country: "Spain",
  latitude: 41.4,
  longitude: 2.16,
};

describe("AC-024.4: the search asks Open-Meteo's geocoding API through the weather client", () => {
  it("calls only geocoding-api.open-meteo.com, with the typed text, 10 results, the language and JSON", async () => {
    const live = await setupLive();
    const response = await search("Gracia", { "accept-language": "ca-ES,ca;q=0.9,en;q=0.5" });
    expect(response.statusCode).toBe(200);
    expect(live.openMeteo.hostsSeen).toEqual([OPEN_METEO_HOSTS.geocoding]);
    const [url] = live.openMeteo.geocodeRequests;
    // These names are UNVERIFIED (TODO(builder) in src/server/weather/geocoding.ts): this pins
    // them in one place, so checking them against the live API means changing one module.
    expect(url?.pathname).toBe("/v1/search");
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      name: "Gracia",
      count: "10",
      language: "ca",
      format: "json",
    });
  });

  it("the URL is built on the geocoding host and nowhere else", () => {
    const url = new URL(geocodeUrl("Gràcia", "es"));
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("geocoding-api.open-meteo.com");
    expect(url.searchParams.get("name")).toBe("Gràcia");
  });

  it("answers the places with coordinates rounded to 2 decimals on the laptop", async () => {
    await setupLive();
    const response = await search("Gracia");
    expect(response.json()).toEqual({ results: [GRACIA] });
  });

  it("counts the call against the daily budget like every other Open-Meteo call", async () => {
    const log: CallLogEntry[] = [];
    const live = await setupLive({ callLog: log });
    await search("Gracia");
    expect(new PersistentCallCounter(live.harness.db, Date.now).countToday()).toBe(1);
    // The call log has the host and the path, never the query (NFR-006).
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain("Gracia");
    expect(log[0]).toMatchObject({ host: OPEN_METEO_HOSTS.geocoding, path: "/v1/search" });
  });
});

describe("AC-024.4: the answer of Open-Meteo is validated and cut down", () => {
  const place = (extra: Record<string, unknown> = {}) => ({
    name: "Madrid",
    admin1: "Community of Madrid",
    country: "Spain",
    latitude: 40.4168,
    longitude: -3.7038,
    ...extra,
  });

  it("returns only name, region, country and the rounded coordinates", () => {
    const [first] = parseGeocodeAnswer({
      results: [
        place({ id: 3117735, elevation: 667, population: 3223334, timezone: "Europe/Madrid" }),
      ],
    });
    expect(first).toEqual({
      name: "Madrid",
      admin1: "Community of Madrid",
      country: "Spain",
      latitude: 40.42,
      longitude: -3.7,
    });
  });

  it("returns at most 10 results, whatever the service sends", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      place({ name: `Place ${String(index)}` }),
    );
    const results = parseGeocodeAnswer({ results: many });
    expect(results).toHaveLength(GEOCODE_MAX_RESULTS);
    expect(results.map((result) => result.name)).toEqual(many.slice(0, 10).map((p) => p.name));
  });

  it("leaves out a place with a wrong shape, impossible coordinates or control characters", () => {
    const results = parseGeocodeAnswer({
      results: [
        place({ latitude: "41.4" }),
        place({ latitude: 91 }),
        place({ longitude: -181 }),
        place({ latitude: null }),
        place({ name: "" }),
        place({ country: undefined }),
        place({ name: "Evil\nName" }),
        place({ admin1: "Zero​Width" }),
        place({ name: "x".repeat(101) }),
        "not an object",
        null,
        place({ name: "Valencia" }),
      ],
    });
    expect(results.map((result) => result.name)).toEqual(["Valencia"]);
  });

  it("takes a place without a region", () => {
    expect(parseGeocodeAnswer({ results: [place({ admin1: undefined })] })[0]).not.toHaveProperty(
      "admin1",
    );
  });

  it("an answer with no results is an empty list, not an error", () => {
    expect(parseGeocodeAnswer({ generationtime_ms: 0.5 })).toEqual([]);
    expect(parseGeocodeAnswer({ results: [] })).toEqual([]);
  });

  it.each([null, "<html>", 42, [], { results: "none" }, { results: { 0: {} } }])(
    "an answer of the wrong shape (%j) makes the search offline",
    (body) => {
      expect(() => parseGeocodeAnswer(body)).toThrow(WeatherUnavailableError);
    },
  );
});

describe("AC-024.4: the route answers 200 with a list, 400, 429, 503 and 404", () => {
  it("an empty result is a 200 with an empty list", async () => {
    await setup(new FakeGeocoder());
    const response = await search("nowhere-at-all");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ results: [] });
  });

  it("Open-Meteo unreachable is a 503 that points to the coordinates", async () => {
    await setup({
      search: () => Promise.reject(new WeatherUnavailableError("could not be reached")),
    });
    const response = await search("Madrid");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 503,
      title: "Search is offline; type the coordinates",
    });
  });

  it("a real geocoder with the service down answers 503 too, and keeps the query out of the problem", async () => {
    const live = await setupLive();
    live.openMeteo.mode = "http-500";
    const response = await search(SECRET_QUERY);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(SECRET_QUERY);
  });

  it("with the onboarding flag off the route does not exist (AC-029.2)", async () => {
    await setup(new FakeGeocoder(), { onboarding: false });
    const response = await search("Madrid");
    expect(response.statusCode).toBe(404);
  });

  it("is behind the session guard: no cookie, no search", async () => {
    const guarded = await setup(new FakeGeocoder());
    const response = await guarded.request({ method: "GET", url: "/api/geocode?q=Madrid" });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ["too short", "é"],
    ["blank", "   "],
    ["too long", "x".repeat(61)],
    ["a newline", "Mad\nrid"],
    ["a tab", "Mad\trid"],
    ["an invisible character", "Mad​rid"],
  ])("refuses a text that is %s with a 400 that does not repeat it", async (_name, text) => {
    await setup(new FakeGeocoder());
    const response = await search(text);
    expect(response.statusCode).toBe(400);
    if (text.trim() !== "") {
      expect(response.body).not.toContain(text.trim());
    }
  });

  it("refuses a missing text and a repeated one", async () => {
    await setup(new FakeGeocoder());
    const missing = await harness!.get("/api/geocode");
    expect(missing.statusCode).toBe(400);
    const twice = await harness!.get("/api/geocode?q=Madrid&q=Paris");
    expect(twice.statusCode).toBe(400);
  });

  it("accepts 2 and 60 characters, counted in code points, after a trim", async () => {
    await setup(new FakeGeocoder());
    expect((await search("  Ma  ")).statusCode).toBe(200);
    expect((await search("🌍".repeat(60))).statusCode).toBe(200);
    expect((await search("🌍".repeat(61))).statusCode).toBe(400);
    expect(parseGeocodeQuery("🌍🌍")).toEqual({ ok: true, query: "🌍🌍" });
  });

  it("the language comes from Accept-Language: es, ca or en by the person's order, en by default", () => {
    expect(languageFromAcceptLanguage(undefined)).toBe("en");
    expect(languageFromAcceptLanguage("")).toBe("en");
    expect(languageFromAcceptLanguage("es-ES,es;q=0.9,en;q=0.8")).toBe("es");
    expect(languageFromAcceptLanguage("en-GB,en;q=0.9,ca;q=0.8")).toBe("en");
    expect(languageFromAcceptLanguage("ca-ES;q=0.9, fr;q=0.8")).toBe("ca");
    expect(languageFromAcceptLanguage("de, ca;q=0.5, es;q=0.9")).toBe("es");
    expect(languageFromAcceptLanguage("fr-FR,fr;q=0.9,de;q=0.5")).toBe("en");
    expect(languageFromAcceptLanguage("es;q=0, ca;q=0.1")).toBe("ca");
    expect(languageFromAcceptLanguage("*")).toBe("en");
  });
});

describe("AC-024.4: 10 searches a minute for each session", () => {
  it("the 11th search in a minute is a 429 with Retry-After, and the minute after it works again", async () => {
    const searches: string[] = [];
    await setup({
      search: (query) => {
        searches.push(query);
        return Promise.resolve([]);
      },
    });
    for (let count = 0; count < 10; count += 1) {
      expect((await search("Madrid")).statusCode).toBe(200);
    }
    const refused = await search("Madrid");
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(refused.json()).toMatchObject({ status: 429 });
    expect(refused.json<{ detail: string }>().detail).toContain("type the coordinates");
    expect(searches).toHaveLength(10); // the refused one never left the laptop

    harness!.clock.advance(61_000);
    expect((await search("Madrid")).statusCode).toBe(200);
  });

  it("is counted per session: a second device keeps its own 10", async () => {
    await setup(new FakeGeocoder());
    const first = harness!;
    for (let count = 0; count < 10; count += 1) {
      await search("Madrid");
    }
    expect((await search("Madrid")).statusCode).toBe(429);
    const second = first.store.issuePairingToken();
    const paired = await first.request({ method: "GET", url: `/pair?token=${second.token}` });
    const cookie = (paired.headers["set-cookie"] as string).split(";")[0] ?? "";
    const other = await first.request({
      method: "GET",
      url: "/api/geocode?q=Madrid",
      headers: { cookie },
    });
    expect(other.statusCode).toBe(200);
  });

  it("an invalid text counts too, so a script cannot probe the validation for free", async () => {
    await setup(new FakeGeocoder());
    for (let count = 0; count < 10; count += 1) {
      expect((await search("x")).statusCode).toBe(400);
    }
    expect((await search("Madrid")).statusCode).toBe(429);
  });

  it("the limiter keeps a bounded number of sessions and counts nothing for a refused request", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(() => now, 2, 1000, 3);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(1);
    now = 999;
    expect(limiter.take("a")).toBe(1);
    now = 1001;
    expect(limiter.take("a")).toBe(0);
    for (const key of ["b", "c", "d", "e"]) {
      limiter.take(key);
    }
    expect(limiter.take("e")).toBe(0);
  });
});

describe("AC-024.4: the text is not logged, cached or stored, and Gemma never sees it", () => {
  it("the request logger drops the query string of the search, as it does for /pair", () => {
    expect(redactUrl(`/api/geocode?q=${encodeURIComponent(SECRET_QUERY)}`)).toBe(
      "/api/geocode?[redacted]",
    );
    const logged = JSON.stringify(
      serializeRequest({
        method: "GET",
        url: `/api/geocode?q=${encodeURIComponent(SECRET_QUERY)}`,
      }),
    );
    expect(logged).not.toContain("Zyxwvut");
  });

  it.each([
    ["a found place", "ok"],
    ["a refused text", "short"],
    ["the service down", "offline"],
    ["too many searches", "limit"],
  ])("no log line holds the text: %s", async (_name, scenario) => {
    const lines: string[] = [];
    const live = await setupLive({ logLines: lines });
    const text = scenario === "short" ? "é" : SECRET_QUERY;
    if (scenario === "offline") {
      live.openMeteo.mode = "http-500";
    }
    if (scenario === "limit") {
      for (let count = 0; count < 10; count += 1) {
        await search(SECRET_QUERY);
      }
    }
    await search(text);
    expect(lines.length).toBeGreaterThan(0); // the logger ran
    const output = lines.join("");
    expect(output).toContain('"url":"/api/geocode?[redacted]"');
    for (const form of [SECRET_QUERY, encodeURIComponent(SECRET_QUERY), "Zyxwvut"]) {
      expect(output).not.toContain(form);
    }
  });

  it("the response is no-store, and the same search twice asks Open-Meteo twice", async () => {
    const live = await setupLive();
    const first = await search("Gracia");
    await search("Gracia");
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(live.openMeteo.geocodeRequests).toHaveLength(2);
  });

  it("nothing of the text is written to the database", async () => {
    const live = await setupLive();
    await search(SECRET_QUERY);
    await search("é"); // refused
    const tables = live.harness.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    const dump = tables
      .map(({ name }) => JSON.stringify(live.harness.db.prepare(`SELECT * FROM "${name}"`).all()))
      .join("\n");
    expect(dump).not.toContain("Zyxwvut");
    // The only trace of the search is the day's call count, which holds no text.
    const keys = live.harness.db
      .prepare<[], { key: string }>("SELECT key FROM weather_cache")
      .all()
      .map((row) => row.key);
    expect(keys.every((key) => key.startsWith("calls|"))).toBe(true);
  });

  it("is never part of a Gemma prompt or decision", async () => {
    const live = await setupLive();
    await search(SECRET_QUERY);
    await live.harness.idle();
    expect(live.harness.model.calls).toEqual([]);
    expect(
      live.harness.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM gemma_decisions").get(),
    ).toEqual({ n: 0 });
  });

  it("no Gemma module imports the place search", () => {
    const folder = new URL("../src/server/gemma/", import.meta.url).pathname;
    for (const file of readdirSync(folder)) {
      const source = readFileSync(join(folder, file), "utf8");
      expect(source, file).not.toMatch(/geocod/i);
    }
  });
});

describe("AC-024.4: with fake weather the search answers from a few synthetic places", () => {
  const search_ = (query: string) => new FakeGeocoder().search(query);

  it("finds Gràcia by name, without the accent, and by its region", async () => {
    expect(await search_("Gràcia")).toEqual([GRACIA]);
    expect(await search_("gracia")).toEqual([GRACIA]);
    expect(await search_("Gràcia, Barcelona")).toEqual([GRACIA]);
    expect(await search_("barcelona")).toEqual([GRACIA]);
  });

  it("knows Madrid, Valencia and Paris, and nothing else", async () => {
    expect((await search_("madrid")).map((place) => place.name)).toEqual(["Madrid"]);
    expect((await search_("valencia")).map((place) => place.name)).toEqual(["Valencia"]);
    expect((await search_("paris")).map((place) => place.name)).toEqual(["Paris"]);
    expect((await search_("spain")).map((place) => place.name)).toEqual([
      "Gràcia",
      "Madrid",
      "Valencia",
    ]);
    expect(await search_("atlantis")).toEqual([]);
  });
});
