import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { judgeScenarioFromAnswer } from "../src/server/fakes.js";
import { FakeModelClient } from "../src/server/model/fake.js";
import type {
  Forecast,
  RecordedWeather,
  WeatherClient,
  WeatherLocation,
} from "../src/server/weather/client.js";
import { FAKE_WEATHER_PROFILES, FakeWeatherClient } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, uploadPhoto, type CoreHarness } from "./core-helpers.js";
import { syntheticPhoto } from "./support/photos.js";

// Synthetic places: two different cities, nothing of a real household.
const PLACE_A = { latitude: 40.42, longitude: -3.7 };
const PLACE_B = { latitude: 48.86, longitude: 2.35 };

/** The fake weather that remembers the place of each forecast request and can hold some back. */
class RecordingWeather implements WeatherClient {
  readonly places: (WeatherLocation | undefined)[] = [];
  private readonly inner: FakeWeatherClient;
  private holdFrom = Number.POSITIVE_INFINITY;
  private gate: Promise<void> = Promise.resolve();
  private open: () => void = () => undefined;

  constructor(now: () => number) {
    this.inner = new FakeWeatherClient(now, FAKE_WEATHER_PROFILES.mild);
  }

  /** From the request with this index on, forecasts wait for `release()`. */
  hold(fromIndex: number): void {
    this.holdFrom = fromIndex;
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.holdFrom = Number.POSITIVE_INFINITY;
    this.open();
  }

  async getForecast(request: Parameters<WeatherClient["getForecast"]>[0]): Promise<Forecast> {
    const index = this.places.push(request.location) - 1;
    if (index >= this.holdFrom) {
      await this.gate;
    }
    return this.inner.getForecast(request);
  }

  getRecorded(request: Parameters<WeatherClient["getRecorded"]>[0]): Promise<RecordedWeather> {
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

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}): Promise<{
  h: CoreHarness;
  model: FakeModelClient;
}> {
  const model = new FakeModelClient({ scenario: judgeScenarioFromAnswer });
  harness = await createCoreHarness({
    model,
    liveWeather: (_db, now) => {
      weather = new RecordingWeather(now);
      return weather;
    },
    ...options,
  });
  await pair(harness);
  return { h: harness, model };
}

async function moveTo(h: CoreHarness, location: WeatherLocation): Promise<void> {
  const response = await h.request({
    method: "PUT",
    url: "/api/onboarding",
    payload: {
      outdoorItems: ["balcony_plants"],
      dryer: "heat-pump",
      airConditioning: false,
      heaterThisSeason: false,
      location,
    },
    headers: { cookie: h.cookie, origin: "http://localhost:8787" },
  });
  expect(response.statusCode).toBe(200);
}

interface CardJson {
  id: number;
  gemma?: { state: string };
  laundry_plan?: { stage: string };
  quote: { id: number } | null;
}

async function newCard(h: CoreHarness, choreType = "plants"): Promise<CardJson> {
  const response = await h.post("/api/cards/quick", { chore_type: choreType });
  expect(response.statusCode).toBe(201);
  return response.json<CardJson>();
}

const cardOf = async (h: CoreHarness, id: number): Promise<CardJson> =>
  (await h.get(`/api/cards/${id}`)).json<CardJson>();

const allPlaces = (): (WeatherLocation | undefined)[] => weather.places;
const onlyPlaceA = (places: readonly (WeatherLocation | undefined)[]): void => {
  expect(places.length).toBeGreaterThan(0);
  expect(places.every((place) => place?.latitude === PLACE_A.latitude)).toBe(true);
  expect(places.every((place) => place?.longitude === PLACE_A.longitude)).toBe(true);
};

describe("AC-014.1: a card's own forecast refetches keep asking for the place the card was made in", () => {
  it("bookmaker Retry asks for the card's place, not the current one", async () => {
    const { h, model } = await setup({ flags: { onboarding: true } });
    await moveTo(h, PLACE_A);
    model.setScenario("bookmaker", "offline");
    const created = await newCard(h);
    await h.idle();
    expect((await cardOf(h, created.id)).gemma?.state).toBe("offline");

    await moveTo(h, PLACE_B);
    model.setScenario("bookmaker", "ok");
    allPlaces().length = 0;
    expect((await h.post(`/api/cards/${created.id}/retry`, {})).statusCode).toBe(200);
    await h.idle();
    expect((await cardOf(h, created.id)).gemma?.state).toBe("answered");
    onlyPlaceA(allPlaces());
  });

  it("bookmaker Answer asks for the card's place, not the current one", async () => {
    const { h, model } = await setup({ flags: { onboarding: true } });
    await moveTo(h, PLACE_A);
    model.setScenario("bookmaker", "unsure");
    const created = await newCard(h);
    await h.idle();
    expect((await cardOf(h, created.id)).gemma?.state).toBe("question");

    await moveTo(h, PLACE_B);
    model.setScenario("bookmaker", "ok");
    allPlaces().length = 0;
    expect((await h.post(`/api/cards/${created.id}/answer`, { yes: true })).statusCode).toBe(200);
    await h.idle();
    onlyPlaceA(allPlaces());
  });

  it("the safety guard, the first bookmaker pass and the final-window check keep the card's place", async () => {
    const { h, model } = await setup({ flags: { onboarding: true, safetyGuard: true } });
    await moveTo(h, PLACE_A);
    model.setScenario("safety", "ok");
    model.setScenario("bookmaker", "settle-moved");
    // The card's own pricing is request 0; the guard and the bookmaker follow it.
    weather.hold(1);
    const created = await newCard(h);
    await vi.waitFor(() => {
      expect(allPlaces().length).toBe(2);
    });
    await moveTo(h, PLACE_B);
    weather.release();
    await h.idle();

    expect((await cardOf(h, created.id)).gemma?.state).toBe("answered");
    expect(model.calls.some((call) => call.job === "safety")).toBe(true);
    expect(allPlaces().length).toBe(3);
    onlyPlaceA(allPlaces().slice(1));
  });

  it("photo odds ask for the card's place, not the current one", async () => {
    const { h, model } = await setup({ flags: { onboarding: true } });
    await moveTo(h, PLACE_A);
    model.setScenario("bookmaker", "unlikely-24h");
    const created = await newCard(h);
    await h.idle();

    await moveTo(h, PLACE_B);
    model.setScenario("bookmaker", "ok");
    allPlaces().length = 0;
    const response = await uploadPhoto(h, created.id, await syntheticPhoto());
    expect(response.statusCode).toBe(201);
    await h.idle();
    expect(model.calls.some((call) => call.job === "inspector")).toBe(true);
    onlyPlaceA(allPlaces());
  });

  it("the laundry planner's re-plan keeps the card's place", async () => {
    const { h, model } = await setup({ flags: { onboarding: true, laundryPlanner: true } });
    await moveTo(h, PLACE_A);
    model.setScenario("laundry-planner", "offline");
    const planned = (await h.post("/api/laundry-plan", {})).json<CardJson>();
    await h.idle();
    expect((await cardOf(h, planned.id)).laundry_plan?.stage).toBe("offline");
    onlyPlaceA(allPlaces());

    await moveTo(h, PLACE_B);
    model.setScenario("laundry-planner", "ok");
    allPlaces().length = 0;
    expect((await h.post(`/api/cards/${planned.id}/retry`, {})).statusCode).toBe(200);
    await h.idle();
    expect((await cardOf(h, planned.id)).laundry_plan?.stage).toBe("ask_need");
    onlyPlaceA(allPlaces());
  });

  it("opening a Skip today bet re-checks the chosen day at the card's place", async () => {
    const { h, model } = await setup({
      flags: { onboarding: true, laundryPlanner: true, safetyGuard: true },
    });
    await moveTo(h, PLACE_A);
    model.setScenario("laundry-planner", "ok");
    model.setScenario("safety", "ok");
    const planned = (await h.post("/api/laundry-plan", {})).json<CardJson>();
    await h.idle();
    expect((await cardOf(h, planned.id)).laundry_plan?.stage).toBe("ask_need");

    await moveTo(h, PLACE_B);
    allPlaces().length = 0;
    const answered = await h.post(`/api/laundry-plan/${planned.id}/need`, { needed: false });
    expect(answered.statusCode).toBe(200);
    await h.idle();
    expect(model.calls.some((call) => call.job === "safety")).toBe(true);
    expect(allPlaces()).toHaveLength(1);
    onlyPlaceA(allPlaces());
  });

  it("an older card without a location falls back to the current location", async () => {
    const { h, model } = await setup({ flags: { onboarding: true } });
    model.setScenario("bookmaker", "offline");
    const created = await newCard(h);
    await h.idle();
    h.db.exec("DROP TRIGGER IF EXISTS cards_write_once_location");
    h.db.prepare("UPDATE cards SET location_lat = NULL, location_lon = NULL").run();

    model.setScenario("bookmaker", "ok");
    allPlaces().length = 0;
    await h.post(`/api/cards/${created.id}/retry`, {});
    await h.idle();
    expect(allPlaces().length).toBeGreaterThan(0);
    expect(allPlaces().every((place) => place === undefined)).toBe(true);
  });

  it("a card stamped while the flag was on keeps its place after the flag is turned off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sib-flag-off-"));
    try {
      const dbPath = join(dir, "should-i-bother.db");
      const first = await setup({ flags: { onboarding: true }, dbPath });
      await moveTo(first.h, PLACE_A);
      first.model.setScenario("bookmaker", "offline");
      const created = await newCard(first.h);
      await first.h.idle();
      await first.h.close();
      harness = undefined;

      // The same database, restarted with the flag off and no household location of its own.
      const { h, model } = await setup({ flags: {}, dbPath });
      model.setScenario("bookmaker", "ok");
      allPlaces().length = 0;
      expect((await h.post(`/api/cards/${created.id}/retry`, {})).statusCode).toBe(200);
      await h.idle();
      onlyPlaceA(allPlaces());
    } finally {
      await harness?.close();
      harness = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC-029.2: with the flag off a photo's refetch names no place either", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "unlikely-24h");
    const created = await newCard(h);
    await h.idle();
    allPlaces().length = 0;
    expect((await uploadPhoto(h, created.id, await syntheticPhoto())).statusCode).toBe(201);
    await h.idle();
    expect(model.calls.some((call) => call.job === "inspector")).toBe(true);
    expect(allPlaces().length).toBeGreaterThan(0);
    expect(allPlaces().every((place) => place === undefined)).toBe(true);
  });

  it("AC-029.2: with the flag off no refetch names a place", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "offline");
    const created = await newCard(h);
    await h.idle();
    model.setScenario("bookmaker", "ok");
    await h.post(`/api/cards/${created.id}/retry`, {});
    await h.idle();
    expect(allPlaces().length).toBeGreaterThan(1);
    expect(allPlaces().every((place) => place === undefined)).toBe(true);
  });
});
