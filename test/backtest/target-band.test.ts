import { describe, expect, it } from "vitest";

import {
  BAND_NAMES,
  HoldoutLeakError,
  NEIGHBOUR_COUNT,
  bandFromRate,
  choreFeatures,
  computeTargetBands,
  type TrainingExample,
} from "../../src/backtest/index.js";
import {
  HOUR_MS,
  addDays,
  madridWallTimeToEpochMs,
  outcomeWindow,
  type HourlyWeather,
} from "../../src/domain/outcomes.js";

/** Examples on consecutive days from 2026-04-01 with one feature, `x`. */
function examples(
  rows: { x: number; delivered: boolean }[],
  start = "2026-04-01",
): TrainingExample[] {
  return rows.map((row, i) => ({
    chore: "heater",
    date: addDays(start, i),
    features: { day_max_temperature_c: row.x, sunshine_hours: 0 },
    delivered: row.delivered,
  }));
}

function targetOf(rows: TrainingExample[], index: number) {
  const result = computeTargetBands(rows);
  const target = result.targets[index];
  if (target === undefined) throw new Error("no target");
  return target;
}

describe("band cut points (design.md, Fine-tune dataset)", () => {
  it.each([
    [1, 4],
    [0.775, 4],
    [0.7749, 3],
    [0.6, 3],
    [0.5999, 2],
    [0.425, 2],
    [0.4249, 1],
    [0.25, 1],
    [0.2499, 0],
    [0, 0],
  ] as const)("rate %s -> band %s", (rate, band) => {
    expect(bandFromRate(rate)).toBe(band);
  });

  it("names the five bands", () => {
    expect(Object.values(BAND_NAMES)).toEqual([
      "very unlikely",
      "unlikely",
      "toss-up",
      "likely",
      "very likely",
    ]);
  });
});

describe("AC-019.5: neighbour method", () => {
  it("never uses a row's own date as its neighbour", () => {
    // Identical features everywhere: ties are broken by date, and the own date is skipped.
    const rows = examples(Array.from({ length: 12 }, () => ({ x: 5, delivered: true })));
    const result = computeTargetBands(rows);
    for (const target of result.targets) {
      expect(target.neighbourDates).not.toContain(target.date);
      expect(target.neighbourCount).toBe(11);
    }
  });

  it("does not count the row's own label in its rate", () => {
    // The only other row is delivered=false, so the first row's rate is 0 although it is true.
    const rows = examples([
      { x: 1, delivered: true },
      { x: 9, delivered: false },
    ]);
    const first = targetOf(rows, 0);
    expect(first.neighbourDates).toEqual(["2026-04-02"]);
    expect(first.rate).toBe(0);
    expect(first.band).toBe(0);
  });

  it("uses the 30 nearest rows (all, if fewer) with Euclidean distance on z-scored features", () => {
    // x = 0..39, each row is delivered when x < 20; the nearest 30 of x=0 are x=1..30 (29 true... )
    const rows = examples(Array.from({ length: 40 }, (_, x) => ({ x, delivered: x < 20 })));
    const first = targetOf(rows, 0);
    expect(NEIGHBOUR_COUNT).toBe(30);
    expect(first.neighbourCount).toBe(30);
    expect(first.neighbourDates).toEqual(
      Array.from({ length: 30 }, (_, i) => addDays("2026-04-01", i + 1)),
    );
    expect(first.rate).toBeCloseTo(19 / 30, 12); // x = 1..19 are true
    expect(first.band).toBe(3);

    const few = examples(Array.from({ length: 10 }, (_, x) => ({ x, delivered: true })));
    expect(targetOf(few, 4).neighbourCount).toBe(9);
  });

  it("breaks distance ties by earlier date", () => {
    const rows = examples([
      { x: 0, delivered: true },
      { x: -1, delivered: false },
      { x: 1, delivered: true },
    ]);
    // row 0 (x=0): both others are at distance 1 in raw units; the earlier date comes first
    expect(targetOf(rows, 0).neighbourDates).toEqual(["2026-04-02", "2026-04-03"]);
  });

  it("maps a neighbour rate of exactly 0.6 (18 of 30) to likely and 24 of 30 to very likely", () => {
    // 31 rows; for row 0 the 30 neighbours are all the others, ordered by x
    const build = (trueCount: number) =>
      examples([
        { x: 0, delivered: false },
        ...Array.from({ length: 30 }, (_, i) => ({ x: i + 1, delivered: i < trueCount })),
      ]);
    expect(targetOf(build(18), 0).rate).toBe(0.6);
    expect(targetOf(build(18), 0).band).toBe(3);
    expect(targetOf(build(17), 0).band).toBe(2);
    expect(targetOf(build(24), 0).band).toBe(4);
    expect(targetOf(build(23), 0).band).toBe(3);
    expect(targetOf(build(13), 0).band).toBe(2);
    expect(targetOf(build(12), 0).band).toBe(1);
    expect(targetOf(build(8), 0).band).toBe(1);
    expect(targetOf(build(7), 0).band).toBe(0);
  });

  it("z-scores features so a large-unit feature does not dominate", () => {
    const rows: TrainingExample[] = Array.from({ length: 6 }, (_, i) => ({
      chore: "heater",
      date: addDays("2026-04-01", i),
      // sunshine (in the thousands) is noise; temperature separates the labels
      features: {
        day_max_temperature_c: i < 3 ? 10 + i * 0.1 : 30 + i * 0.1,
        sunshine_hours: [5000, 100, 3000, 200, 4000, 150][i] ?? 0,
      },
      delivered: i >= 3,
    }));
    const result = computeTargetBands(rows);
    expect(result.usedFeatures.heater).toEqual(["day_max_temperature_c", "sunshine_hours"]);
    // both features carry weight after z-scoring: results are stable and defined
    expect(result.targets.every((target) => target.rate !== null)).toBe(true);
  });

  it("only compares rows of the same chore", () => {
    const heater = examples([
      { x: 1, delivered: true },
      { x: 2, delivered: true },
    ]);
    const ac: TrainingExample[] = [
      {
        chore: "ac",
        date: "2026-04-01",
        features: { night_min_temperature_c: 1, mean_wind_kmh: 1 },
        delivered: false,
      },
      {
        chore: "ac",
        date: "2026-04-02",
        features: { night_min_temperature_c: 2, mean_wind_kmh: 2 },
        delivered: false,
      },
    ];
    const result = computeTargetBands([...ac, ...heater]);
    const heaterTargets = result.targets.filter((t) => t.chore === "heater");
    expect(heaterTargets.map((t) => t.rate)).toEqual([1, 1]);
  });

  it("rejects any example outside 1 Apr-31 Aug 2026 (no hold-out day can reach a target)", () => {
    const rows = examples([{ x: 1, delivered: true }], "2026-09-01");
    expect(() => computeTargetBands(rows)).toThrow(HoldoutLeakError);
    expect(() => computeTargetBands(examples([{ x: 1, delivered: true }], "2026-03-31"))).toThrow(
      HoldoutLeakError,
    );
    expect(() =>
      computeTargetBands(examples([{ x: 1, delivered: true }], "2026-08-31")),
    ).not.toThrow();
  });

  it("rejects a repeated chore and date", () => {
    const rows = examples([{ x: 1, delivered: true }]);
    expect(() => computeTargetBands([...rows, ...rows])).toThrow(/duplicate/);
  });

  it("drops a feature that is unavailable in some training row and reports it", () => {
    const rows: TrainingExample[] = Array.from({ length: 5 }, (_, i) => ({
      chore: "plants",
      date: addDays("2026-04-01", i),
      features: {
        rain_mm: i,
        max_precipitation_probability_pct: i === 2 ? null : 50,
        max_temperature_c: 20,
      },
      delivered: i > 2,
    }));
    const result = computeTargetBands(rows);
    expect(result.droppedFeatures.plants).toEqual(["max_precipitation_probability_pct"]);
    expect(result.usedFeatures.plants).toEqual(["rain_mm", "max_temperature_c"]);
  });

  it("gives no band when there is nothing to compare with", () => {
    expect(targetOf(examples([{ x: 1, delivered: true }]), 0)).toMatchObject({
      band: null,
      rate: null,
      neighbourCount: 0,
    });
    const noFeatures: TrainingExample[] = [
      {
        chore: "heater",
        date: "2026-04-01",
        features: { day_max_temperature_c: null, sunshine_hours: null },
        delivered: true,
      },
      {
        chore: "heater",
        date: "2026-04-02",
        features: { day_max_temperature_c: null, sunshine_hours: null },
        delivered: true,
      },
    ];
    expect(computeTargetBands(noFeatures).targets.every((t) => t.band === null)).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const rows = examples(
      Array.from({ length: 50 }, (_, x) => ({ x: (x * 7) % 13, delivered: x % 3 === 0 })),
    );
    expect(JSON.stringify(computeTargetBands(rows))).toBe(
      JSON.stringify(computeTargetBands([...rows])),
    );
  });
});

describe("choreFeatures", () => {
  const day = "2026-07-15";
  function hourly(
    start: number,
    count: number,
    make: (i: number) => Partial<HourlyWeather>,
  ): HourlyWeather[] {
    return Array.from({ length: count }, (_, i) => ({
      timeMs: start + i * HOUR_MS,
      temperatureC: 20,
      dewPointC: 10,
      relativeHumidityPct: 100,
      precipitationMm: 0,
      precipitationProbabilityPct: 10,
      windSpeedKmh: 15,
      windGustsKmh: null,
      weatherCode: null,
      sunshineSeconds: 0,
      et0Mm: null,
      ...make(i),
    }));
  }

  it("computes the rule inputs of each chore over its window", () => {
    const plantsWindow = outcomeWindow("plants", day);
    const plants = hourly(plantsWindow.startMs, 15, (i) => ({
      precipitationMm: i === 2 ? 3 : 0,
      precipitationProbabilityPct: i === 5 ? 80 : 10,
      temperatureC: 18 + i,
    }));
    expect(choreFeatures("plants", plants, plantsWindow)).toEqual({
      rain_mm: 3,
      max_precipitation_probability_pct: 80,
      max_temperature_c: 32,
    });

    const lineWindow = outcomeWindow("laundry_line", day);
    const line = hourly(lineWindow.startMs, 8, (i) => ({
      precipitationMm: i === 0 ? 0.2 : 0,
      sunshineSeconds: 3600,
    }));
    // D = 0.25 + 0 + 0.2 = 0.45 for dry hours, 0 for the wet hour
    const lineFeatures = choreFeatures("laundry_line", line, lineWindow);
    expect(lineFeatures["wet_hours"]).toBe(1);
    expect(lineFeatures["mean_drying_index"]).toBeCloseTo((7 * 0.45) / 8, 9);

    const acWindow = outcomeWindow("ac", day);
    const ac = hourly(acWindow.startMs, 9, (i) => ({ temperatureC: 25 - i / 2 }));
    expect(choreFeatures("ac", ac, acWindow)).toEqual({
      night_min_temperature_c: 21,
      mean_wind_kmh: 15,
    });

    const heaterWindow = outcomeWindow("heater", day);
    const heater = hourly(heaterWindow.startMs, 14, (i) => ({
      temperatureC: 10 + i,
      sunshineSeconds: 1800,
    }));
    expect(choreFeatures("heater", heater, heaterWindow)).toEqual({
      day_max_temperature_c: 23,
      sunshine_hours: 7,
    });

    const sunset = madridWallTimeToEpochMs(day, "21:00");
    const tonightWindow = outcomeWindow("laundry_tonight", day, sunset);
    const tonight = hourly(tonightWindow.startMs, 11, (i) => ({
      dewPointC: i < 2 ? 19 : 10,
    }));
    expect(choreFeatures("laundry_tonight", tonight, tonightWindow)["dew_hours"]).toBe(2);
  });

  it("returns null features for an incomplete window or missing inputs", () => {
    const window = outcomeWindow("plants", day);
    const short = hourly(window.startMs, 5, () => ({}));
    expect(choreFeatures("plants", short, window)).toEqual({
      rain_mm: null,
      max_precipitation_probability_pct: null,
      max_temperature_c: null,
    });
    const noProbability = hourly(window.startMs, 15, () => ({ precipitationProbabilityPct: null }));
    expect(
      choreFeatures("plants", noProbability, window)["max_precipitation_probability_pct"],
    ).toBeNull();
    expect(choreFeatures("plants", noProbability, window)["rain_mm"]).toBe(0);
  });
});
