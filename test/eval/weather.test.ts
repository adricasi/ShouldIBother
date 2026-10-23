import { describe, expect, it } from "vitest";

import { HOUR_MS, madridWallTimeToEpochMs } from "../../src/domain/time.js";
import { syntheticForecast, syntheticRecorded, weatherSpecSchema } from "../../src/eval/weather.js";

const NOON = madridWallTimeToEpochMs("2026-07-14", "12:00");

describe("T-010/T-030: synthetic eval weather", () => {
  it("a named profile gives consecutive hours with the past hours before now", () => {
    const { hours } = syntheticForecast("hot", NOON, 48, 24);
    expect(hours).toHaveLength(72);
    expect(hours[0]?.startsAt).toBe(NOON - 24 * HOUR_MS);
    for (const [index, hour] of hours.entries()) {
      expect(hour.startsAt).toBe(NOON - 24 * HOUR_MS + index * HOUR_MS);
      expect(hour.temperatureC).toBe(31);
    }
  });

  it("segments change the weather where they start, and the last one runs to the end", () => {
    const spec = weatherSpecSchema.parse([{ hours: 6, temperatureC: 20 }, { temperatureC: 30 }]);
    const { hours } = syntheticForecast(spec, NOON, 24);
    expect(hours).toHaveLength(24);
    expect(hours.slice(0, 6).every((hour) => hour.temperatureC === 20)).toBe(true);
    expect(hours.slice(6).every((hour) => hour.temperatureC === 30)).toBe(true);
  });

  it("segments that are too short are extended with the last profile", () => {
    const spec = weatherSpecSchema.parse([
      { hours: 3, temperatureC: 20 },
      { hours: 3, temperatureC: 25 },
    ]);
    const { hours } = syntheticForecast(spec, NOON, 10);
    expect(hours).toHaveLength(10);
    expect(hours.slice(6).every((hour) => hour.temperatureC === 25)).toBe(true);
  });

  it("rain is counted from the start of its own segment", () => {
    const spec = weatherSpecSchema.parse([
      { hours: 4, temperatureC: 20 },
      { temperatureC: 18, rain: { startsAfterHours: 2, hours: 2, mmPerHour: 1.5 } },
    ]);
    const { hours } = syntheticForecast(spec, NOON, 12);
    const wet = hours.map((hour) => hour.precipitationMm).map((mm) => (mm ?? 0) > 0);
    expect(wet).toEqual([
      ...Array<boolean>(6).fill(false),
      true,
      true,
      ...Array<boolean>(4).fill(false),
    ]);
  });

  it("gives the fake sunset of each date for laundry tonight", () => {
    const { sunsetMsByDate } = syntheticForecast("mild", NOON, 48);
    expect(sunsetMsByDate["2026-07-14"]).toBe(madridWallTimeToEpochMs("2026-07-14", "20:00"));
  });

  it("recorded weather has the same hours with the field names of the settlement", () => {
    const recorded = syntheticRecorded("rainy", NOON, 24);
    expect(recorded).toHaveLength(24);
    expect(recorded.some((hour) => (hour.precipitationMm ?? 0) > 0)).toBe(true);
  });

  it("rejects a misspelt field instead of ignoring it", () => {
    expect(weatherSpecSchema.safeParse([{ temperature: 20 }]).success).toBe(false);
    expect(weatherSpecSchema.safeParse("sunny-ish").success).toBe(false);
  });
});
