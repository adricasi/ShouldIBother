import { afterEach, describe, expect, it } from "vitest";

import { RESCUE_CHECK_INTERVAL_MS } from "../src/server/ledger/rescue.js";
import {
  WeatherUnavailableError,
  type Forecast,
  type RecordedWeather,
  type WeatherClient,
  type WeatherLocation,
} from "../src/server/weather/client.js";
import { FAKE_WEATHER_PROFILES, FakeWeatherClient } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { MINUTE, seedBet, tap } from "./support/settle.js";

// Synthetic places: two different cities, nothing of a real household.
const PLACE_A = { latitude: 40.42, longitude: -3.7 };
const PLACE_B = { latitude: 48.86, longitude: 2.35 };

interface Seen {
  readonly kind: "forecast" | "recorded";
  readonly location: WeatherLocation | undefined;
}

/** The fake weather that remembers which place each request named. */
class RecordingWeather implements WeatherClient {
  readonly seen: Seen[] = [];
  private readonly inner: FakeWeatherClient;
  constructor(now: () => number, down = false) {
    this.inner = new FakeWeatherClient(now, FAKE_WEATHER_PROFILES.rainy);
    this.down = down;
  }
  down: boolean;
  getForecast(request: Parameters<WeatherClient["getForecast"]>[0]): Promise<Forecast> {
    this.seen.push({ kind: "forecast", location: request.location });
    return this.down
      ? Promise.reject(new WeatherUnavailableError("down"))
      : this.inner.getForecast(request);
  }
  getRecorded(request: Parameters<WeatherClient["getRecorded"]>[0]): Promise<RecordedWeather> {
    this.seen.push({ kind: "recorded", location: request.location });
    return this.inner.getRecorded(request);
  }
  latestForecastFetchedAt(): number | undefined {
    return this.inner.latestForecastFetchedAt();
  }
}

let harness: CoreHarness | undefined;
let weather: RecordingWeather;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(flags: { onboarding?: boolean; rescue?: boolean }): Promise<CoreHarness> {
  harness = await createCoreHarness({
    flags,
    liveWeather: (_db, now) => {
      weather = new RecordingWeather(now);
      return weather;
    },
  });
  await pair(harness);
  return harness;
}

const answers = (location: WeatherLocation) => ({
  outdoorItems: ["balcony_plants"],
  dryer: "heat-pump",
  airConditioning: false,
  heaterThisSeason: false,
  location,
});

async function moveTo(location: WeatherLocation): Promise<void> {
  const h = harness!;
  const response = await h.request({
    method: "PUT",
    url: "/api/onboarding",
    payload: answers(location),
    headers: { cookie: h.cookie, origin: "http://localhost:8787" },
  });
  expect(response.statusCode).toBe(200);
}

async function placeBet(): Promise<number> {
  const h = harness!;
  const card = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<{
    id: number;
    quote: { id: number };
  }>();
  const response = await h.post("/api/bets", {
    card_id: card.id,
    quote_id: card.quote.id,
    kind: "do_nothing",
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: number }>().id;
}

const settleAtOf = (betId: number): number =>
  harness!.db
    .prepare<[number], { settle_at: number }>("SELECT settle_at FROM bets WHERE id = ?")
    .get(betId)!.settle_at;

const recorded = (): Seen[] => weather.seen.filter((entry) => entry.kind === "recorded");

describe("AC-014.1: a bet is judged where it was priced, also after the household moved", () => {
  it("settlement asks for the weather of the card's own location, not the current one", async () => {
    const h = await setup({ onboarding: true });
    await moveTo(PLACE_A);
    const betId = await placeBet();
    expect(
      h.db.prepare("SELECT location_lat AS lat, location_lon AS lon FROM cards").get(),
    ).toEqual({ lat: PLACE_A.latitude, lon: PLACE_A.longitude });

    await moveTo(PLACE_B);
    h.clock.current = settleAtOf(betId) + MINUTE;
    const { body } = await tap(h, betId, "moist");
    expect(body.state).toBe("settled");

    expect(recorded().length).toBeGreaterThan(0);
    expect(recorded().every((entry) => entry.location?.latitude === PLACE_A.latitude)).toBe(true);
    expect(recorded().every((entry) => entry.location?.longitude === PLACE_A.longitude)).toBe(true);

    // A card made after the move is stamped with the new place.
    await placeBet();
    const places = h.db
      .prepare<[], { lat: number }>("SELECT location_lat AS lat FROM cards ORDER BY id")
      .all()
      .map((row) => row.lat);
    expect(places).toEqual([PLACE_A.latitude, PLACE_B.latitude]);
  });

  it("the stored location is write-once", async () => {
    const h = await setup({ onboarding: true });
    await moveTo(PLACE_A);
    await placeBet();
    expect(() => h.db.prepare("UPDATE cards SET location_lat = 1").run()).toThrow(
      /cannot be updated/,
    );
  });

  it("an older card without a location falls back to the current location", async () => {
    const h = await setup({ onboarding: true });
    const betId = seedBet(h, { settleOffsetMs: -MINUTE, status: "due" });
    await tap(h, betId, "moist");
    expect(recorded().length).toBeGreaterThan(0);
    expect(recorded().every((entry) => entry.location === undefined)).toBe(true);
  });

  it("AC-029.2: with the flag off no location is stored and no request names a place", async () => {
    const h = await setup({});
    const betId = await placeBet();
    expect(h.db.prepare("SELECT location_lat AS lat FROM cards").get()).toEqual({ lat: null });
    h.clock.current = settleAtOf(betId) + MINUTE;
    await tap(h, betId, "moist");
    expect(weather.seen.every((entry) => entry.location === undefined)).toBe(true);
  });

  it("the rescue check reads the forecast of each bet's own place, one request per place", async () => {
    const h = await setup({ onboarding: true, rescue: true });
    await moveTo(PLACE_A);
    await placeBet();
    await moveTo(PLACE_B);
    await placeBet();
    h.clock.advance(RESCUE_CHECK_INTERVAL_MS + MINUTE);
    weather.seen.length = 0;
    expect(await h.core.scheduler.tickRescue()).toBe(2);
    expect(weather.seen.map((entry) => entry.location?.latitude)).toEqual([
      PLACE_A.latitude,
      PLACE_B.latitude,
    ]);
  });

  it("a place whose forecast is down leaves only its own bets unchecked", async () => {
    const h = await setup({ onboarding: true, rescue: true });
    await moveTo(PLACE_A);
    await placeBet();
    await moveTo(PLACE_B);
    await placeBet();
    h.clock.advance(RESCUE_CHECK_INTERVAL_MS + MINUTE);
    const inner = weather;
    const original = inner.getForecast.bind(inner);
    inner.getForecast = (request) =>
      request.location?.latitude === PLACE_A.latitude
        ? Promise.reject(new WeatherUnavailableError("down"))
        : original(request);
    expect(await h.core.scheduler.tickRescue()).toBe(1);
  });
});
