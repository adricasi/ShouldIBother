import { describe, expect, it } from "vitest";

import { cutWindowOf, labelWindowOf, luckyWinOf } from "../../src/domain/lucky-win.js";
import { HOUR_MS, type HourlyWeather } from "../../src/domain/outcomes.js";
import { madridWallTimeToEpochMs } from "../../src/domain/time.js";
import { digestOf } from "../../src/domain/weather-digest.js";

function hours(
  fromMs: number,
  count: number,
  values: Partial<HourlyWeather> = {},
): HourlyWeather[] {
  return Array.from({ length: count }, (_unused, index) => ({
    timeMs: Math.floor(fromMs / HOUR_MS) * HOUR_MS + index * HOUR_MS,
    temperatureC: 20,
    dewPointC: 10,
    relativeHumidityPct: 50,
    precipitationMm: 0,
    precipitationProbabilityPct: 0,
    windSpeedKmh: 10,
    windGustsKmh: 20,
    weatherCode: 1,
    sunshineSeconds: 1800,
    et0Mm: 0.1,
    ...values,
  }));
}

const placedAt = madridWallTimeToEpochMs("2026-10-22", "10:00");
const plantsSettle = madridWallTimeToEpochMs("2026-10-23", "08:00");

describe("lucky win from the outcome labels (AC-008.6)", () => {
  it("the label window is the chore's full fixed window; it is cut at the end only where hours are missing", () => {
    // Plants placed at 10:00: 19:00 to 10:00 next day, whatever the settle time.
    const afterWindow = madridWallTimeToEpochMs("2026-10-23", "11:00");
    expect(labelWindowOf("plants", { placedAt, settleAt: plantsSettle }, afterWindow)).toEqual({
      startMs: madridWallTimeToEpochMs("2026-10-22", "19:00"),
      endMs: madridWallTimeToEpochMs("2026-10-23", "10:00"),
    });
    // At the settle time (08:00) the last two hours are not there yet.
    expect(labelWindowOf("plants", { placedAt, settleAt: plantsSettle }, plantsSettle)).toEqual({
      startMs: madridWallTimeToEpochMs("2026-10-22", "19:00"),
      endMs: plantsSettle,
    });
    // Line-dry placed at 13:00 keeps its 10:00 start: those hours were recorded before the bet.
    const lineSettle = madridWallTimeToEpochMs("2026-10-22", "18:00");
    const placed13 = madridWallTimeToEpochMs("2026-10-22", "13:00");
    expect(
      labelWindowOf("laundry_line", { placedAt: placed13, settleAt: lineSettle }, lineSettle + 1),
    ).toEqual({ startMs: madridWallTimeToEpochMs("2026-10-22", "10:00"), endMs: lineSettle });
  });

  it("the fallback cut keeps only the hours the bet was open", () => {
    const small = madridWallTimeToEpochMs("2026-10-22", "02:00");
    const acSettle = madridWallTimeToEpochMs("2026-10-22", "07:00");
    expect(cutWindowOf("ac", { placedAt: small, settleAt: acSettle })).toEqual({
      startMs: small,
      endMs: acSettle,
    });
    const late = madridWallTimeToEpochMs("2026-10-22", "22:00");
    expect(cutWindowOf("plants", { placedAt: late, settleAt: plantsSettle }).startMs).toBe(late);
  });

  it("plants: ET0 minus rain above 1 mm is lucky, below is not", () => {
    const window = { startMs: placedAt, endMs: plantsSettle };
    expect(luckyWinOf("plants", window, hours(placedAt, 23, { et0Mm: 0.3 }))).toBe(true);
    expect(
      luckyWinOf("plants", window, hours(placedAt, 23, { et0Mm: 0.3, precipitationMm: 0.5 })),
    ).toBe(false);
  });

  it("line-dry: a rainy hour makes a win lucky; a bet placed at 13:00 is labelled on 10:00 to 18:00", () => {
    const tenAm = madridWallTimeToEpochMs("2026-10-22", "10:00");
    const settleAt = madridWallTimeToEpochMs("2026-10-22", "18:00");
    const window = { startMs: tenAm, endMs: settleAt };
    // D = 0.5 x 0.5 + 0.3 x 0.5 + 0.2 x 0.5 = 0.5 per hour (wind 15 of 30): 8 hours give 4.0, the 5 hours after
    // 13:00 only 2.5 (below 3.0).
    const steady = hours(tenAm, 8, {
      windSpeedKmh: 15,
      relativeHumidityPct: 50,
      sunshineSeconds: 1800,
    });
    expect(luckyWinOf("laundry_line", window, steady)).toBe(false);
    expect(
      luckyWinOf("laundry_line", { startMs: placedAt + 3 * HOUR_MS, endMs: settleAt }, steady),
    ).toBe(true);
    const wet = steady.map((hour, index) => (index === 3 ? { ...hour, precipitationMm: 1 } : hour));
    expect(luckyWinOf("laundry_line", window, wet)).toBe(true);
  });

  it("is null, not false, when the recorded hours lack what the label needs", () => {
    const window = { startMs: placedAt, endMs: plantsSettle };
    expect(luckyWinOf("plants", window, hours(placedAt, 23, { precipitationMm: null }))).toBeNull();
    expect(luckyWinOf("plants", window, [])).toBeNull();
  });
});

describe("weather digest", () => {
  it("sums rain, counts wet hours and keeps null where a value is missing", () => {
    const digest = digestOf([
      ...hours(placedAt, 2, { precipitationMm: 0.15 }),
      ...hours(placedAt + 2 * HOUR_MS, 1, { precipitationMm: 2, temperatureC: 25 }),
    ]);
    expect(digest).toMatchObject({
      hours: 3,
      rain_mm: 2.3,
      wet_hours: 1,
      temp_min_c: 20,
      temp_max_c: 25,
      wind_max_kmh: 10,
      sunshine_h: 1.5,
    });
    expect(
      digestOf(hours(placedAt, 2, { precipitationMm: null, sunshineSeconds: null })),
    ).toMatchObject({
      rain_mm: null,
      wet_hours: null,
      sunshine_h: null,
    });
  });
});
