import { describe, expect, it } from "vitest";

import { labelWindowOf, luckyWinOf } from "../../src/domain/lucky-win.js";
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
  it("the label window is the chore's fixed window cut to the time the bet was open", () => {
    // Plants: 19:00 to 10:00 next day, cut at the settle time 08:00.
    expect(labelWindowOf("plants", { placedAt, settleAt: plantsSettle })).toEqual({
      startMs: madridWallTimeToEpochMs("2026-10-22", "19:00"),
      endMs: plantsSettle,
    });
    // A bet placed at 22:00 can only be judged from 22:00.
    const late = madridWallTimeToEpochMs("2026-10-22", "22:00");
    expect(labelWindowOf("plants", { placedAt: late, settleAt: plantsSettle }).startMs).toBe(late);
    // An AC bet placed after midnight uses its own window.
    const small = madridWallTimeToEpochMs("2026-10-22", "02:00");
    const acSettle = madridWallTimeToEpochMs("2026-10-22", "07:00");
    expect(labelWindowOf("ac", { placedAt: small, settleAt: acSettle })).toEqual({
      startMs: small,
      endMs: acSettle,
    });
  });

  it("plants: ET0 minus rain above 1 mm is lucky, below is not", () => {
    const bet = { placedAt, settleAt: plantsSettle };
    expect(luckyWinOf("plants", bet, hours(placedAt, 23, { et0Mm: 0.3 }))).toBe(true);
    expect(
      luckyWinOf("plants", bet, hours(placedAt, 23, { et0Mm: 0.3, precipitationMm: 0.5 })),
    ).toBe(false);
  });

  it("line-dry: a rainy hour makes a win lucky", () => {
    const settleAt = madridWallTimeToEpochMs("2026-10-22", "18:00");
    const bet = { placedAt, settleAt };
    const dry = hours(placedAt, 8, {
      windSpeedKmh: 30,
      relativeHumidityPct: 30,
      sunshineSeconds: 3600,
    });
    expect(luckyWinOf("laundry_line", bet, dry)).toBe(false);
    const wet = dry.map((hour, index) => (index === 3 ? { ...hour, precipitationMm: 1 } : hour));
    expect(luckyWinOf("laundry_line", bet, wet)).toBe(true);
  });

  it("is null, not false, when the recorded hours lack what the label needs", () => {
    const bet = { placedAt, settleAt: plantsSettle };
    expect(luckyWinOf("plants", bet, hours(placedAt, 23, { precipitationMm: null }))).toBeNull();
    expect(luckyWinOf("plants", bet, [])).toBeNull();
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
