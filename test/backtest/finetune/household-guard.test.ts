import { describe, expect, it, vi } from "vitest";

import {
  HouseholdLeakError,
  assertNoHouseholdValues,
  householdHits,
  householdProbes,
  loadSyntheticHabits,
  sortedHabits,
} from "../../../src/backtest/index.js";
import { syntheticSnapshot } from "../support/synthetic-weather.js";

import { buildWith, exampleProbes, parseLines } from "./support.js";

vi.setConfig({ testTimeout: 60_000 });

const PLANTED = {
  dryer: "zephyr-dryer",
  flat: "Carrer del Test 12",
  location: { latitude: 41.3874, longitude: 2.1701 },
  airConditioning: true,
  occupants: 3,
};

describe("the household probes", () => {
  const probes = householdProbes(PLANTED);

  it("finds a string as a whole word, ignoring case, and names where it came from", () => {
    expect(householdHits({ a: "I use the ZEPHYR-DRYER daily" }, probes)).toEqual(["dryer"]);
    expect(householdHits({ a: "zephyr-dryers" }, probes)).toEqual([]);
    expect(householdHits({ a: "carrer del test 12" }, probes)).toEqual(["flat"]);
  });

  it("finds coordinates as written and rounded to 2 decimals, but not other numbers", () => {
    expect(householdHits({ a: "at 41.3874 north" }, probes)).toEqual(["location.latitude"]);
    expect(householdHits({ a: "lat 41.39" }, probes)).toEqual(["location.latitude"]);
    expect(householdHits({ a: "long 2.17" }, probes)).toEqual(["location.longitude"]);
    expect(householdHits({ a: "temp 141.39 and 41.391" }, probes)).toEqual([]);
    expect(householdHits({ a: "3 people, true" }, probes)).toEqual([]);
  });

  it("finds a value that JSON escaping would hide from a plain text search", () => {
    const quoted = householdProbes({ nickname: 'the "big" flat' });
    expect(householdHits({ habits: { home: 'the "big" flat' } }, quoted)).toEqual(["nickname"]);
  });

  it("ignores very short strings", () => {
    expect(householdProbes({ a: "ab", b: "" })).toEqual([]);
  });
});

describe("AC-019.8: a household value in a row fails the dataset build", () => {
  it("fails with the row and the household.json path, never the value", () => {
    const probes = householdProbes(PLANTED);
    let error: unknown;
    try {
      assertNoHouseholdValues(
        [
          { id: "plants|2026-05-01", value: { messages: [{ content: "all fine" }] } },
          { id: "ac|2026-06-01", value: { messages: [{ content: "I use the zephyr-dryer" }] } },
        ],
        probes,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HouseholdLeakError);
    expect((error as HouseholdLeakError).leaks).toEqual(["ac|2026-06-01: dryer"]);
    expect((error as Error).message).not.toContain("zephyr");
  });

  it("stops the build when a habit carries a household value", async () => {
    const snapshot = await syntheticSnapshot({
      startDate: "2026-08-24",
      requestedEndDate: "2026-09-06",
    });
    const habits = { ...loadSyntheticHabits(), drying: "a zephyr-dryer in the hall" };
    await expect(buildWith(snapshot, householdProbes(PLANTED), { habits })).rejects.toThrow(
      HouseholdLeakError,
    );
    // The same snapshot builds when the habits are the synthetic profile.
    const ok = await buildWith(snapshot, householdProbes(PLANTED));
    expect(parseLines(ok.trainJsonl).length).toBeGreaterThan(0);
  });

  it("stops the build when a planted coordinate is in a habit", async () => {
    const snapshot = await syntheticSnapshot({
      startDate: "2026-08-24",
      requestedEndDate: "2026-09-06",
    });
    const habits = { ...loadSyntheticHabits(), balcony: "south of 41.3874" };
    await expect(buildWith(snapshot, householdProbes(PLANTED), { habits })).rejects.toThrow(
      /location\.latitude/,
    );
  });
});

describe("the synthetic habit profile", () => {
  it("shares no value with any household the app accepts", () => {
    const habits = sortedHabits(loadSyntheticHabits());
    // Every dryer the config allows, and the committed example's values.
    const possible = ["heat-pump", "condenser", "vented", "none"].map((dryer) => ({ dryer }));
    for (const household of possible) {
      expect(householdHits(habits, householdProbes(household)), household.dryer).toEqual([]);
    }
    expect(householdHits(habits, exampleProbes())).toEqual([]);
  });

  it("is made of short plain facts", () => {
    const habits = loadSyntheticHabits();
    expect(Object.keys(habits).length).toBeGreaterThanOrEqual(4);
    for (const value of Object.values(habits)) {
      expect(typeof value === "boolean" || value.length <= 100).toBe(true);
    }
  });
});
