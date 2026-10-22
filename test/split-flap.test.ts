import { afterEach, describe, expect, it } from "vitest";

import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import flagsSource from "../config/flags.json" with { type: "json" };

let harness: CoreHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface Board {
  temperature_c: number | null;
  condition: string;
  rain_pct: number | null;
  wind_kmh: number | null;
  hours: { hour: number; level: number | null; lazy: boolean }[];
  lazy_window: { from: string; to: string } | null;
}

async function setup(flags: { splitFlap?: boolean }): Promise<CoreHarness> {
  harness = await createCoreHarness({ flags, weatherProfile: FAKE_WEATHER_PROFILES.breezy });
  await pair(harness);
  return harness;
}

async function today(): Promise<Record<string, unknown> & { weather_board?: Board | null }> {
  const response = await harness!.get("/api/today");
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe("T-027: REQ-026 the splitFlap flag", () => {
  it("is off by default in config/flags.json", () => {
    expect((flagsSource as Record<string, boolean>)["splitFlap"]).toBe(false);
  });

  it("with the flag off /api/today has no weather_board field and makes no forecast call", async () => {
    const h = await setup({});
    const body = await today();
    expect(body).not.toHaveProperty("weather_board");
    expect(h.weather.requests).toHaveLength(0);
  });

  it("AC-026.1: with the flag on and no forecast cached yet the board is null, with no call", async () => {
    const h = await setup({ splitFlap: true });
    expect((await today()).weather_board).toBeNull();
    expect(h.weather.requests).toHaveLength(0);
  });

  it("AC-026.1: after a card was priced the board comes from the cached forecast, no extra call", async () => {
    const h = await setup({ splitFlap: true });
    expect((await h.post("/api/cards/quick", { chore_type: "laundry_line" })).statusCode).toBe(201);
    await h.idle();
    const calls = h.weather.requests.length;
    const board = (await today()).weather_board;
    expect(h.weather.requests).toHaveLength(calls);
    expect(board).toMatchObject({ temperature_c: 22, condition: "Mostly clear", wind_kmh: 30 });
    expect(board?.hours.length).toBeGreaterThan(0);
    // 10:00 Madrid now; the breezy profile dries the line until the fake sunset at 20:00.
    expect(board?.lazy_window).toEqual({ from: "10:00", to: "20:00" });
  });
});
