import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTRIBUTION } from "../src/domain/open-meteo.js";
import { madridWallTime } from "../src/domain/time.js";
import {
  collectRecordedWeather,
  RECORDED_WEATHER_RETRY_MS,
} from "../src/server/ledger/recorded-weather.js";
import type { BetRow } from "../src/server/ledger/rows.js";
import { WeatherUnavailableError } from "../src/server/weather/client.js";
import { FAKE_WEATHER_PROFILES, type FakeWeatherProfile } from "../src/server/weather/fake.js";
import { OpenMeteoWeatherClient } from "../src/server/weather/open-meteo-client.js";

import {
  createCoreHarness,
  pair,
  type CoreHarness,
  type CoreHarnessOptions,
} from "./core-helpers.js";
import { FakeClock, T0 } from "./helpers.js";
import { FakeOpenMeteo } from "./support/fake-open-meteo.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GRACIA = { latitude: 41.4045, longitude: 2.1555 };

interface CardJson {
  id: number;
  kind: string;
  chore_type: string;
  title: string;
  alert_reason: string | null;
  notice: string | null;
  quote: null | {
    id: number;
    band: number;
    band_name: string;
    odds: number;
    source: string;
    settle_at: string;
    reason: string;
    label: string;
  };
}
interface TodayJson {
  cards: CardJson[];
  attribution: string;
  forecast: null | { fetched_at: string; age_label: string; stale: boolean };
}

let harness: CoreHarness;
let server: FakeOpenMeteo | undefined;

afterEach(async () => {
  await harness.close();
  await server?.stop();
  server = undefined;
});

async function setup(options: CoreHarnessOptions = {}): Promise<CoreHarness> {
  harness = await createCoreHarness(options);
  await pair(harness);
  return harness;
}

/** The app on the real Open-Meteo client, talking to a fake HTTP server (no network). */
async function setupLive(options: CoreHarnessOptions = {}, profile?: FakeWeatherProfile) {
  const clock = options.clock ?? new FakeClock();
  server = new FakeOpenMeteo(clock.now);
  if (profile !== undefined) {
    server.profile = profile;
  }
  await server.start();
  const transport = server.transport;
  let weather: OpenMeteoWeatherClient | undefined;
  await setup({
    ...options,
    clock,
    liveWeather: (db, now) => {
      weather = new OpenMeteoWeatherClient({
        db,
        now,
        location: GRACIA,
        fetch: transport,
        sleep: () => Promise.resolve(),
        random: () => 0,
      });
      return weather;
    },
  });
  return { harness, server, weather: weather!, clock };
}

const quick = async (choreType: string): Promise<CardJson> => {
  const response = await harness.post("/api/cards/quick", { chore_type: choreType });
  expect(response.statusCode).toBe(201);
  return response.json<CardJson>();
};

const today = async (): Promise<TodayJson> => (await harness.get("/api/today")).json<TodayJson>();

describe("AC-012.1: the fixed heat, frost and storm backstop shows a Do it now alert", () => {
  it.each([
    ["heat", FAKE_WEATHER_PROFILES.heatwave, "Heat: up to 36 °C is forecast."],
    ["frost", FAKE_WEATHER_PROFILES.frost, "Frost: down to 1 °C is forecast."],
    ["storm", FAKE_WEATHER_PROFILES.storm, "Storm: thunderstorms are forecast."],
  ])(
    "%s: an alert card with the reason, no odds and no bet action",
    async (_name, profile, reason) => {
      await setup({ weatherProfile: profile });
      const card = await quick("plants");
      expect(card).toMatchObject({
        kind: "alert",
        alert_reason: reason,
        quote: null,
        title: "Water plants",
      });
      expect(harness.model.calls).toHaveLength(0); // no Gemma answer can change it
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM quotes").get()).toEqual({ n: 0 });

      const shown = (await today()).cards;
      expect(shown.map((c) => [c.kind, c.alert_reason])).toEqual([["alert", reason]]);
    },
  );

  it("applies to every chore's window: the same heat stops line-dry too", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.heatwave });
    expect((await quick("laundry_line")).kind).toBe("alert");
  });

  it("uses the limits exactly: 34.9 °C is a normal card, 35 °C an alert", async () => {
    await setup({ weatherProfile: { temperatureC: 34.9, dryProbabilityPct: 0 } });
    expect((await quick("plants")).kind).toBe("weather");
    harness.weather.setProfile({ temperatureC: 35, dryProbabilityPct: 0 });
    expect((await quick("plants")).kind).toBe("alert");
  });

  it("a mild day stays a normal card with odds", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.mild });
    expect((await quick("plants")).kind).toBe("weather");
  });
});

describe("AC-012.2: a request to place a bet on an alert card is rejected", () => {
  it("answers 409 with the reason, for a bet and for I'll do it, and stores nothing", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.heatwave });
    const card = await quick("plants");
    for (const kind of ["do_nothing", "do_it"]) {
      const response = await harness.post("/api/bets", { card_id: card.id, quote_id: 1, kind });
      expect(response.statusCode).toBe(409);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json<{ detail: string }>().detail).toContain("Heat");
    }
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 0 });
  });
});

describe("AC-016.4: line-dry today is offered from 07:00 to 15:00", () => {
  async function lineDryAt(hour: number, minute: number): Promise<CardJson> {
    const clock = new FakeClock();
    clock.current = madridWallTime(T0, 0, hour, minute);
    await setup({ clock, weatherProfile: FAKE_WEATHER_PROFILES.breezy });
    return quick("laundry_line");
  }

  it.each([
    [7, 0],
    [10, 30],
    [14, 59],
  ])(
    "at %i:%i the card quotes the rule odds and settles the same day at 18:00",
    async (hour, minute) => {
      const card = await lineDryAt(hour, minute);
      expect(card.kind).toBe("weather");
      expect(card.title).toBe("Line-dry today (skip the dryer)");
      expect(card.quote).toMatchObject({
        band: 4,
        band_name: "very likely",
        odds: 85,
        source: "rule",
      });
      expect(Date.parse(card.quote?.settle_at ?? "")).toBe(madridWallTime(T0, 0, 18));
    },
  );

  it.each([
    [6, 59, "today at 07:00"],
    [15, 0, "tomorrow at 07:00"],
    [22, 30, "tomorrow at 07:00"],
  ])("at %i:%i there is no bet, and the card says when: %s", async (hour, minute, when) => {
    const card = await lineDryAt(hour, minute);
    expect(card).toMatchObject({ kind: "coming_later", quote: null });
    expect(card.notice).toBe(`Offered from 07:00 to 15:00. Next chance: ${when}.`);
    const bet = await harness.post("/api/bets", {
      card_id: card.id,
      quote_id: 1,
      kind: "do_nothing",
    });
    expect(bet.statusCode).toBe(409);
  });

  it("a wet afternoon makes line-dry very unlikely (any wet hour)", async () => {
    const clock = new FakeClock();
    await setup({
      clock,
      weatherProfile: { temperatureC: 20, rain: { startsAfterHours: 3, hours: 1, mmPerHour: 0.2 } },
    });
    expect((await quick("laundry_line")).quote).toMatchObject({ band: 0, odds: 15 });
  });

  it("is one of the quick chips' chores; plants and line-dry both work from the chip endpoint", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.mild });
    expect((await quick("plants")).chore_type).toBe("plants");
    expect((await quick("laundry_line")).chore_type).toBe("laundry_line");
    const unknown = await harness.post("/api/cards/quick", { chore_type: "laundry_plan" });
    expect(unknown.statusCode).toBe(400);
  });
});

describe("AC-016.5: AC and heater are not needed when the household does not use them", () => {
  const notUsed = { airConditioning: false, heaterThisSeason: false, dryer: "heat-pump" } as const;
  const used = { airConditioning: true, heaterThisSeason: true, dryer: "heat-pump" } as const;

  it.each(["ac", "heater"])(
    "%s: 'Not needed this season', no odds, no bet action",
    async (chore) => {
      await setup({
        household: notUsed,
        flags: { heater: true },
        weatherProfile: FAKE_WEATHER_PROFILES.mild,
      });
      const card = await quick(chore);
      expect(card).toMatchObject({
        kind: "coming_later",
        notice: "Not needed this season",
        quote: null,
      });
      const bet = await harness.post("/api/bets", {
        card_id: card.id,
        quote_id: 1,
        kind: "do_nothing",
      });
      expect(bet.statusCode).toBe(409);
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 0 });
      expect((await today()).cards[0]?.notice).toBe("Not needed this season");
    },
  );

  it("is decided by the baseline, whether or not the flag is on", async () => {
    await setup({ household: notUsed, flags: {} });
    expect((await quick("ac")).notice).toBe("Not needed this season");
  });

  it("when the baseline says they are used and the flag is on, the card has rule odds", async () => {
    await setup({
      household: used,
      flags: { heater: true },
      weatherProfile: { temperatureC: 19, dryProbabilityPct: 0 },
    });
    const ac = await quick("ac");
    expect(ac).toMatchObject({ kind: "weather", quote: { band: 4, source: "rule" } });
    const heater = await quick("heater");
    expect(heater.kind).toBe("weather");
    expect(heater.quote?.band).toBe(3); // 19 °C: not the 20 °C row, so the 18 °C one
  });

  it("when used but the feature flag is off, they read Coming later", async () => {
    await setup({ household: used, flags: {} });
    expect(await quick("ac")).toMatchObject({
      kind: "coming_later",
      notice: "Coming later",
      quote: null,
    });
  });

  it("laundry tonight reads Coming later while its feature flag is off", async () => {
    await setup({ flags: {} });
    expect(await quick("laundry_tonight")).toMatchObject({ notice: "Coming later", quote: null });
  });
});

describe("AC-004.1: rule odds within 1 s of capture", () => {
  it("with a forecast younger than 1 h cached", async () => {
    const { harness: live } = await setupLive({}, FAKE_WEATHER_PROFILES.rainy);
    await quick("plants"); // warms the cache
    const started = performance.now();
    const card = await quick("plants");
    const elapsed = performance.now() - started;
    expect(card.quote?.source).toBe("rule");
    expect(elapsed).toBeLessThan(1000);
    expect(server?.forecastRequests).toHaveLength(1);
    expect(live).toBe(harness);
  });

  it("when the forecast has to be fetched first (fetch included, local server)", async () => {
    await setupLive({}, FAKE_WEATHER_PROFILES.rainy);
    const started = performance.now();
    const card = await quick("plants");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(card.quote).toMatchObject({ band: 1, odds: 35 }); // cool, no rain ahead
  });
});

describe("REQ-014 through the app, on the Open-Meteo client and a fake HTTP server", () => {
  beforeEach(() => undefined);

  it("AC-014.1 and AC-014.2: one request for the configured, rounded coordinates, reused within 1 h", async () => {
    await setupLive();
    await quick("plants");
    await quick("laundry_line");
    const requests = server?.forecastRequests ?? [];
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("latitude")).toBe("41.4");
    expect(requests[0]?.searchParams.get("longitude")).toBe("2.16");
    harness.clock.advance(HOUR);
    await quick("plants");
    expect(server?.forecastRequests).toHaveLength(2);
  });

  it("AC-014.3: Open-Meteo unreachable, the cached forecast is used and its age shown", async () => {
    await setupLive();
    await quick("plants");
    expect((await today()).forecast).toMatchObject({
      age_label: "Forecast from just now",
      stale: false,
    });
    harness.clock.advance(3 * HOUR);
    if (server !== undefined) {
      server.mode = "http-500";
    }
    const card = await quick("plants");
    expect(card.kind).toBe("weather");
    expect(card.quote?.source).toBe("rule");
    expect((await today()).forecast).toMatchObject({
      age_label: "Forecast from 3 h ago",
      stale: true,
    });
  });

  it("AC-014.4: with no forecast younger than 24 h the card says so and betting is refused", async () => {
    await setupLive();
    await quick("plants");
    harness.clock.advance(24 * HOUR);
    if (server !== undefined) {
      server.mode = "http-500";
    }
    const card = await quick("plants");
    expect(card).toMatchObject({
      kind: "coming_later",
      quote: null,
      notice: "No forecast, can't set odds",
    });
    const bet = await harness.post("/api/bets", {
      card_id: card.id,
      quote_id: 1,
      kind: "do_nothing",
    });
    expect(bet.statusCode).toBe(409);
    expect((await today()).forecast).toBeNull(); // nothing usable is left to show an age for
  });

  it("AC-014.4: and the same on a first start with Open-Meteo down", async () => {
    await setupLive();
    if (server !== undefined) {
      server.mode = "http-500";
    }
    expect(await quick("laundry_line")).toMatchObject({
      quote: null,
      notice: "No forecast, can't set odds",
    });
  });

  it("AC-014.6: Today carries the Open-Meteo attribution; the README has it too", async () => {
    await setup();
    const { attribution } = await today();
    expect(attribution).toBe(ATTRIBUTION);
    expect(attribution).toContain("Open-Meteo");
    expect(attribution).toContain("CC BY 4.0");
    expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain(ATTRIBUTION);
  });

  it("AC-014.7: the app only ever contacted the Open-Meteo host of the forecast API", async () => {
    await setupLive();
    await quick("plants");
    expect(server?.hostsSeen).toEqual(["api.open-meteo.com"]);
  });
});

describe("AC-014.5: recorded weather that is not there yet keeps the bet waiting, retried every 30 min", () => {
  async function dueBet() {
    const { weather } = await setupLive({}, FAKE_WEATHER_PROFILES.rainy);
    const card = await quick("plants");
    const placed = await harness.post("/api/bets", {
      card_id: card.id,
      quote_id: card.quote?.id,
      kind: "do_nothing",
    });
    expect(placed.statusCode).toBe(201);
    const bet = harness.db.prepare<[], BetRow>("SELECT * FROM bets").get()!;
    harness.clock.current = bet.settle_at + MINUTE;
    harness.core.scheduler.tick();
    return {
      weather,
      bet: harness.db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(bet.id)!,
    };
  }
  const status = (): string =>
    harness.db.prepare<[], { status: string }>("SELECT status FROM bets").get()!.status;

  it("moves to awaiting_weather, asks again after 30 minutes and moves on once the weather is complete", async () => {
    const { weather, bet } = await dueBet();
    expect(bet.status).toBe("due");
    // The analysis for the last hours of the window is not published yet.
    server!.nullFromMs = bet.settle_at - 2 * HOUR;
    const deps = { db: harness.db, now: harness.clock.now, weather };

    expect(await collectRecordedWeather(deps, bet)).toBeUndefined();
    expect(status()).toBe("awaiting_weather");
    const asked = server!.recordedRequests.length;
    expect(asked).toBeGreaterThan(0);

    // The scheduler does not ask before 30 minutes have passed since the last try...
    harness.clock.advance(RECORDED_WEATHER_RETRY_MS - MINUTE);
    expect(await harness.core.scheduler.tickWeather()).toBe(0);
    expect(server!.recordedRequests.length).toBe(asked);
    // ...but does at 30 minutes, and again 30 minutes later, while it is still missing.
    harness.clock.advance(MINUTE);
    await harness.core.scheduler.tickWeather();
    expect(server!.recordedRequests.length).toBe(asked + 1);
    expect(status()).toBe("awaiting_weather");
    harness.clock.advance(RECORDED_WEATHER_RETRY_MS);
    await harness.core.scheduler.tickWeather();
    expect(server!.recordedRequests.length).toBe(asked + 2);

    // Once Open-Meteo has the hours, the next try releases the bet to the judge.
    server!.nullFromMs = undefined;
    harness.clock.advance(RECORDED_WEATHER_RETRY_MS);
    expect(await harness.core.scheduler.tickWeather()).toBe(1);
    expect(status()).toBe("awaiting_gemma");
    // Nothing is retried for a bet that is no longer waiting for weather.
    harness.clock.advance(RECORDED_WEATHER_RETRY_MS);
    const before = server!.recordedRequests.length;
    await harness.core.scheduler.tickWeather();
    expect(server!.recordedRequests.length).toBe(before);
  });

  it("keeps waiting while Open-Meteo is unreachable, and never settles by itself", async () => {
    const { weather, bet } = await dueBet();
    server!.mode = "http-500";
    const deps = { db: harness.db, now: harness.clock.now, weather };
    expect(await collectRecordedWeather(deps, bet)).toBeUndefined();
    harness.clock.advance(RECORDED_WEATHER_RETRY_MS);
    await harness.core.scheduler.tickWeather();
    harness.clock.advance(RECORDED_WEATHER_RETRY_MS);
    await harness.core.scheduler.tickWeather();
    expect(status()).toBe("awaiting_weather");
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 0 });
  });

  it("a complete window is handed to the settlement at once and the bet stays due", async () => {
    const { weather, bet } = await dueBet();
    const deps = { db: harness.db, now: harness.clock.now, weather };
    const recorded = await collectRecordedWeather(deps, bet);
    expect(recorded?.complete).toBe(true);
    expect(recorded?.hours.length).toBeGreaterThan(0);
    expect(status()).toBe("due");
    // Nothing is left to say it is still waiting.
    expect(
      harness.db
        .prepare("SELECT COUNT(*) AS n FROM weather_cache WHERE key LIKE 'recorded-attempt|%'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("a fake weather client that is down surfaces as waiting too", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    harness.weather.failWith = new Error("down");
    await expect(harness.weather.getRecorded({ fromMs: 0, toMs: HOUR })).rejects.toBeInstanceOf(
      WeatherUnavailableError,
    );
  });
});

describe("tapping a chip again does not stack quiet cards", () => {
  const cardCount = (): number =>
    harness.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cards").get()!.n;

  it("while Open-Meteo is down: the same 'No forecast' card, until 30 minutes have passed", async () => {
    await setup();
    harness.weather.failWith = new Error("down");
    const first = await quick("plants");
    harness.clock.advance(10 * MINUTE);
    const second = await quick("plants");
    expect(second.id).toBe(first.id);
    expect(cardCount()).toBe(1);
    expect((await today()).cards).toHaveLength(1);

    harness.clock.advance(21 * MINUTE); // 31 minutes after the first
    const third = await quick("plants");
    expect(third.id).not.toBe(first.id);
    expect(cardCount()).toBe(2);
  });

  it("another chore, or another reason, is its own card", async () => {
    await setup();
    harness.weather.failWith = new Error("down");
    const plants = await quick("plants");
    const lineDry = await quick("laundry_line");
    expect(lineDry.id).not.toBe(plants.id);
    expect(cardCount()).toBe(2);
  });

  it("'Not needed this season' and 'Coming later' are reused too", async () => {
    await setup({ household: { airConditioning: false, heaterThisSeason: false, dryer: "none" } });
    const ac = await quick("ac");
    expect((await quick("ac")).id).toBe(ac.id);
    const tonight = await quick("laundry_tonight");
    expect((await quick("laundry_tonight")).id).toBe(tonight.id);
    expect(cardCount()).toBe(2);
  });

  it("an alert is reused while it says the same, and a new reason is a new card", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.heatwave });
    const alert = await quick("plants");
    expect((await quick("plants")).id).toBe(alert.id);
    harness.weather.setProfile(FAKE_WEATHER_PROFILES.frost);
    const frost = await quick("plants");
    expect(frost.id).not.toBe(alert.id);
    expect(cardCount()).toBe(2);
  });

  it("a card with odds is never reused: each tap is its own bet slip", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.mild });
    const first = await quick("plants");
    const second = await quick("plants");
    expect(second.id).not.toBe(first.id);
  });
});

describe("whole windows: the AC's night is priced from 22:00 even when it is under way (REQ-016)", () => {
  it("at 03:00 the AC card has rule odds from the hours before now", async () => {
    const clock = new FakeClock();
    clock.current = madridWallTime(T0, 1, 3); // 03:00 Madrid on 23 Oct
    await setup({
      clock,
      household: { airConditioning: true, heaterThisSeason: true, dryer: "none" },
      flags: { heater: true },
      weatherProfile: { temperatureC: 19, dryProbabilityPct: 0 },
    });
    const card = await quick("ac");
    expect(card).toMatchObject({ kind: "weather", quote: { band: 4, source: "rule" } });
    expect(Date.parse(card.quote?.settle_at ?? "")).toBe(madridWallTime(T0, 1, 7));
    // The forecast was asked for the 24 hours before now as well.
    expect(harness.weather.requests[0]).toMatchObject({ fromMs: clock.now(), hours: 48 });
  });

  it("the live API reaches back a day for it (past_days) and the live client prices it", async () => {
    const clock = new FakeClock();
    clock.current = madridWallTime(T0, 1, 3);
    await setupLive(
      {
        clock,
        household: { airConditioning: true, heaterThisSeason: true, dryer: "none" },
        flags: { heater: true },
      },
      { temperatureC: 19, dryProbabilityPct: 0 },
    );
    const card = await quick("ac");
    expect(card.kind).toBe("weather");
    expect(server?.forecastRequests[0]?.searchParams.get("past_days")).toBe("1");
  });

  it("an extreme hour with missing sunshine and is_day still stops the card (AC-012.1)", async () => {
    await setupLive({}, FAKE_WEATHER_PROFILES.heatwave);
    server!.nullVariables = ["sunshine_duration", "is_day", "precipitation_probability"];
    expect(await quick("plants")).toMatchObject({ kind: "alert", quote: null });
  });
});
