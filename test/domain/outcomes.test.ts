import { describe, expect, it } from "vitest";

import {
  DECISION_TIMES,
  HOUR_MS,
  IncompleteWeatherError,
  OUTCOME_CHORES,
  acOutcome,
  addDays,
  dateRange,
  decisionTimeMs,
  dryingIndex,
  heaterOutcome,
  isLuckyWin,
  laundryTonightOutcome,
  lineDryOutcome,
  madridDateOf,
  madridWallTimeToEpochMs,
  outcomeLabel,
  outcomeWindow,
  plantsOutcome,
  selectWindowHours,
  windowHourStarts,
  type HourlyWeather,
  type OutcomeChore,
} from "../../src/domain/outcomes.js";

function hour(timeMs: number, overrides: Partial<HourlyWeather> = {}): HourlyWeather {
  return {
    timeMs,
    temperatureC: 20,
    dewPointC: 10,
    relativeHumidityPct: 50,
    precipitationMm: 0,
    precipitationProbabilityPct: 0,
    windSpeedKmh: 10,
    windGustsKmh: 20,
    weatherCode: 1,
    sunshineSeconds: 0,
    et0Mm: 0,
    ...overrides,
  };
}

/** n hours starting at a Madrid wall time, all with the same overrides. */
function hours(
  date: string,
  time: string,
  count: number,
  overrides: Partial<HourlyWeather> = {},
): HourlyWeather[] {
  const start = madridWallTimeToEpochMs(date, time);
  return Array.from({ length: count }, (_, i) => hour(start + i * HOUR_MS, overrides));
}

describe("Europe/Madrid helpers", () => {
  it("converts wall-clock times with the right offset in winter and summer", () => {
    expect(new Date(madridWallTimeToEpochMs("2026-01-15", "19:00")).toISOString()).toBe(
      "2026-01-15T18:00:00.000Z",
    );
    expect(new Date(madridWallTimeToEpochMs("2026-07-15", "19:00")).toISOString()).toBe(
      "2026-07-15T17:00:00.000Z",
    );
  });

  it("handles the spring-forward and fall-back days", () => {
    // 2026-03-29 02:00 -> 03:00 and 2026-10-25 03:00 -> 02:00
    expect(new Date(madridWallTimeToEpochMs("2026-03-29", "10:00")).toISOString()).toBe(
      "2026-03-29T08:00:00.000Z",
    );
    expect(new Date(madridWallTimeToEpochMs("2026-10-25", "10:00")).toISOString()).toBe(
      "2026-10-25T09:00:00.000Z",
    );
  });

  it("finds the Madrid date of an instant near midnight", () => {
    expect(madridDateOf(Date.UTC(2026, 5, 30, 22, 30))).toBe("2026-07-01");
    expect(madridDateOf(Date.UTC(2026, 11, 31, 22, 30))).toBe("2026-12-31");
  });

  it("does calendar arithmetic and ranges on date strings", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
    expect(dateRange("2026-08-30", "2026-09-02")).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
    expect(dateRange("2026-09-02", "2026-09-01")).toEqual([]);
  });

  it("rejects malformed or impossible dates and times", () => {
    expect(() => addDays("2026-13-01", 1)).toThrow();
    expect(() => addDays("2026-02-30", 1)).toThrow();
    expect(() => addDays("26-02-01", 1)).toThrow();
    expect(() => madridWallTimeToEpochMs("2026-02-01", "7pm")).toThrow();
  });
});

describe("decision times and windows (design.md, Outcome labels)", () => {
  it("has the fixed decision time of each chore", () => {
    expect(DECISION_TIMES).toEqual({
      plants: "19:00",
      laundry_line: "09:00",
      laundry_tonight: "20:00",
      ac: "21:00",
      heater: "08:00",
    });
    expect(new Date(decisionTimeMs("plants", "2026-07-15")).toISOString()).toBe(
      "2026-07-15T17:00:00.000Z",
    );
  });

  it("has the window of each chore", () => {
    const iso = (ms: number): string => new Date(ms).toISOString();
    const plants = outcomeWindow("plants", "2026-07-15");
    expect([iso(plants.startMs), iso(plants.endMs)]).toEqual([
      "2026-07-15T17:00:00.000Z",
      "2026-07-16T08:00:00.000Z",
    ]);
    const line = outcomeWindow("laundry_line", "2026-07-15");
    expect([iso(line.startMs), iso(line.endMs)]).toEqual([
      "2026-07-15T08:00:00.000Z",
      "2026-07-15T16:00:00.000Z",
    ]);
    const sunset = Date.UTC(2026, 6, 15, 19, 40);
    const tonight = outcomeWindow("laundry_tonight", "2026-07-15", sunset);
    expect([iso(tonight.startMs), iso(tonight.endMs)]).toEqual([
      "2026-07-15T19:40:00.000Z",
      "2026-07-16T06:00:00.000Z",
    ]);
    const ac = outcomeWindow("ac", "2026-07-15");
    expect([iso(ac.startMs), iso(ac.endMs)]).toEqual([
      "2026-07-15T20:00:00.000Z",
      "2026-07-16T05:00:00.000Z",
    ]);
    const heater = outcomeWindow("heater", "2026-07-15");
    expect([iso(heater.startMs), iso(heater.endMs)]).toEqual([
      "2026-07-15T06:00:00.000Z",
      "2026-07-15T20:00:00.000Z",
    ]);
  });

  it("needs the sunset for laundry tonight", () => {
    expect(() => outcomeWindow("laundry_tonight", "2026-07-15")).toThrow(/sunset/);
  });

  it("counts window hours across the DST changes", () => {
    const count = (date: string): number => windowHourStarts(outcomeWindow("plants", date)).length;
    expect(count("2026-07-15")).toBe(15); // 19:00 -> 10:00
    expect(count("2026-03-28")).toBe(14); // night with 23 hours
    expect(count("2026-10-24")).toBe(16); // night with 25 hours
  });

  it("includes the hour that contains a mid-hour sunset", () => {
    const sunset = madridWallTimeToEpochMs("2026-07-15", "21:20");
    const starts = windowHourStarts(outcomeWindow("laundry_tonight", "2026-07-15", sunset));
    expect(starts[0]).toBe(madridWallTimeToEpochMs("2026-07-15", "21:00"));
    expect(starts).toHaveLength(11); // 21:00 .. 07:00 next day
  });

  it("keeps every decision before its window ends by less than 24 hours", () => {
    for (const chore of OUTCOME_CHORES) {
      const sunset = madridWallTimeToEpochMs("2026-07-15", "21:00");
      const window = outcomeWindow(chore, "2026-07-15", sunset);
      expect(window.endMs - decisionTimeMs(chore, "2026-07-15")).toBeLessThan(24 * HOUR_MS);
    }
  });
});

describe("drying index", () => {
  it("is 0.5*min(wind,30)/30 + 0.3*(100-RH)/100 + 0.2*sunshine/3600", () => {
    expect(
      dryingIndex({
        precipitationMm: 0,
        windSpeedKmh: 15,
        relativeHumidityPct: 50,
        sunshineSeconds: 1800,
      }),
    ).toBeCloseTo(0.25 + 0.15 + 0.1, 9);
  });

  it("caps wind at 30 km/h and tops out at 1.0", () => {
    expect(
      dryingIndex({
        precipitationMm: 0,
        windSpeedKmh: 80,
        relativeHumidityPct: 0,
        sunshineSeconds: 3600,
      }),
    ).toBe(1);
  });

  it("scores a wet hour (>= 0.2 mm) as 0", () => {
    const base = { windSpeedKmh: 30, relativeHumidityPct: 0, sunshineSeconds: 3600 };
    expect(dryingIndex({ ...base, precipitationMm: 0.2 })).toBe(0);
    expect(dryingIndex({ ...base, precipitationMm: 0.19 })).toBe(1);
  });
});

describe("plants label: ET0 - rain <= 1.0 mm over 19:00 -> 10:00", () => {
  const day = "2026-07-15";
  const window = outcomeWindow("plants", day);
  const base = hours(day, "19:00", 15, { et0Mm: 0, precipitationMm: 0 });

  function withTotals(et0: number, rain: number): HourlyWeather[] {
    return base.map((h, i) => ({
      ...h,
      et0Mm: i === 0 ? et0 : 0,
      precipitationMm: i === 1 ? rain : 0,
    }));
  }

  it("is true exactly at the 1.0 mm bound and false just above", () => {
    expect(plantsOutcome(withTotals(3.5, 2.5)).delivered).toBe(true);
    expect(plantsOutcome(withTotals(3.5, 2.4)).delivered).toBe(false);
    expect(plantsOutcome(withTotals(1, 0)).delivered).toBe(true);
    expect(plantsOutcome(withTotals(1.01, 0)).delivered).toBe(false);
  });

  it("ignores floating-point noise at the bound", () => {
    const noisy = base.map((h, i) => ({
      ...h,
      et0Mm: i < 3 ? 0.1 : 0,
      precipitationMm: i === 3 ? 0.3 : 0,
    }));
    // 0.1 + 0.1 + 0.1 = 0.30000000000000004; net 0 -> true; and 1.0 exactly:
    expect(plantsOutcome(noisy).delivered).toBe(true);
    const bound = base.map((h, i) => ({
      ...h,
      et0Mm: i < 3 ? 0.1 : i === 3 ? 0.7 : 0,
      precipitationMm: i === 4 ? 0.0 : 0,
    }));
    expect(plantsOutcome(bound).delivered).toBe(true);
    expect(plantsOutcome(bound).measures["netDeficitMm"]).toBe(1);
  });

  it("is labelled et0_minus_rain when ET0 is present", () => {
    const label = plantsOutcome(withTotals(3, 1));
    expect(label.basis).toBe("et0_minus_rain");
    expect(label.measures).toEqual({ et0Mm: 3, rainMm: 1, netDeficitMm: 2 });
  });

  it("falls back to rain >= 2 mm, labelled, when ET0 is missing for any hour", () => {
    const fallback = (rain: number): HourlyWeather[] =>
      withTotals(9, rain).map((h, i) => (i === 7 ? { ...h, et0Mm: null } : h));
    expect(plantsOutcome(fallback(2)).delivered).toBe(true);
    expect(plantsOutcome(fallback(1.9)).delivered).toBe(false);
    expect(plantsOutcome(fallback(2)).basis).toBe("rain_only_fallback");
  });

  it("throws when rain is missing", () => {
    const broken = base.map((h, i) => (i === 2 ? { ...h, precipitationMm: null } : h));
    expect(() => plantsOutcome(broken)).toThrow(IncompleteWeatherError);
  });

  it("outcomeLabel selects the window from a longer series", () => {
    const longer = [
      ...hours(day, "12:00", 7, { et0Mm: 5 }),
      ...withTotals(3.5, 2.5),
      ...hours("2026-07-16", "10:00", 5, { et0Mm: 5 }),
    ];
    expect(outcomeLabel("plants", longer, window).delivered).toBe(true);
  });

  it("outcomeLabel throws when an hour of the window is missing", () => {
    expect(() => outcomeLabel("plants", base.slice(1), window)).toThrow(IncompleteWeatherError);
  });
});

describe("line-dry label: no wet hour and sum of D >= 3.0 over 10:00 -> 18:00", () => {
  const day = "2026-07-15";
  // D = 0.25 (wind 15) + 0 (RH 100) + 0.125 (2250 s) = 0.375; 8 hours -> 3.0
  const dry = (sunshineSeconds: number): HourlyWeather[] =>
    hours(day, "10:00", 8, {
      windSpeedKmh: 15,
      relativeHumidityPct: 100,
      sunshineSeconds,
    });

  it("is true exactly at sum D = 3.0 and false just below", () => {
    expect(lineDryOutcome(dry(2250)).delivered).toBe(true);
    expect(lineDryOutcome(dry(2250)).measures["dryingSum"]).toBe(3);
    expect(lineDryOutcome(dry(2240)).delivered).toBe(false);
  });

  it("is false with a single wet hour (0.2 mm) even when D is high", () => {
    const rainy = dry(3600).map((h, i) => (i === 3 ? { ...h, precipitationMm: 0.2 } : h));
    expect(lineDryOutcome(rainy).delivered).toBe(false);
    const drizzle = dry(3600).map((h, i) => (i === 3 ? { ...h, precipitationMm: 0.19 } : h));
    expect(lineDryOutcome(drizzle).delivered).toBe(true);
  });

  it("throws on missing wind", () => {
    const broken = dry(3600).map((h, i) => (i === 0 ? { ...h, windSpeedKmh: null } : h));
    expect(() => lineDryOutcome(broken)).toThrow(IncompleteWeatherError);
  });
});

describe("laundry-tonight label: no wet hour and fewer than 3 dew hours", () => {
  const day = "2026-07-15";
  const sunset = madridWallTimeToEpochMs(day, "21:00");
  const night = hours(day, "21:00", 11, { temperatureC: 20, dewPointC: 10 });

  function withDewHours(count: number, spread: number): HourlyWeather[] {
    return night.map((h, i) => (i < count ? { ...h, dewPointC: h.temperatureC! - spread } : h));
  }

  it("is true with 2 dew hours and false with 3", () => {
    expect(laundryTonightOutcome(withDewHours(2, 2)).delivered).toBe(true);
    expect(laundryTonightOutcome(withDewHours(3, 2)).delivered).toBe(false);
  });

  it("counts a spread of exactly 2.0 C but not 2.1 C", () => {
    expect(laundryTonightOutcome(withDewHours(3, 2.1)).delivered).toBe(true);
    expect(laundryTonightOutcome(withDewHours(3, 2)).measures["dewHours"]).toBe(3);
  });

  it("is false with any wet hour", () => {
    const wet = night.map((h, i) => (i === 5 ? { ...h, precipitationMm: 0.2 } : h));
    expect(laundryTonightOutcome(wet).delivered).toBe(false);
  });

  it("is computed over the window that starts at sunset", () => {
    const window = outcomeWindow("laundry_tonight", day, sunset);
    expect(outcomeLabel("laundry_tonight", night, window).delivered).toBe(true);
  });
});

describe("AC label: night minimum below 23 C over 22:00 -> 07:00", () => {
  const night = (minimum: number): HourlyWeather[] =>
    hours("2026-07-15", "22:00", 9, { temperatureC: 26 }).map((h, i) =>
      i === 4 ? { ...h, temperatureC: minimum } : h,
    );

  it("is true at 22.9 and false at 23.0", () => {
    expect(acOutcome(night(22.9)).delivered).toBe(true);
    expect(acOutcome(night(23)).delivered).toBe(false);
  });
});

describe("heater label: day max >= 18 C, or >= 15 C with 5 h of sunshine", () => {
  const day = (maximum: number, sunshineSeconds: number): HourlyWeather[] =>
    hours("2026-01-15", "08:00", 14, {
      temperatureC: 10,
      sunshineSeconds: 0,
    }).map((h, i) => (i === 0 ? { ...h, temperatureC: maximum, sunshineSeconds } : h));

  const sunny = (maximum: number, totalSeconds: number): HourlyWeather[] =>
    day(maximum, 0).map((h, i) => (i < 5 ? { ...h, sunshineSeconds: totalSeconds / 5 } : h));

  it("is true at max 18.0 and false at 17.9 without sun", () => {
    expect(heaterOutcome(day(18, 0)).delivered).toBe(true);
    expect(heaterOutcome(day(17.9, 0)).delivered).toBe(false);
  });

  it("is true at max 15 with exactly 5 h of sunshine, false just below either bound", () => {
    expect(heaterOutcome(sunny(15, 18000)).delivered).toBe(true);
    expect(heaterOutcome(sunny(15, 17995)).delivered).toBe(false);
    expect(heaterOutcome(sunny(14.9, 36000)).delivered).toBe(false);
  });
});

describe("AC-008.6: lucky win", () => {
  it("is a win whose recorded weather does not meet the label", () => {
    const base = hours("2026-07-15", "19:00", 15, { et0Mm: 0.5 });
    expect(isLuckyWin(plantsOutcome(base))).toBe(true); // net 7.5 mm deficit
    expect(isLuckyWin(plantsOutcome(base.map((h) => ({ ...h, et0Mm: 0 }))))).toBe(false);
  });
});

describe("selectWindowHours", () => {
  it("returns the window's hours in order", () => {
    const window = outcomeWindow("heater", "2026-07-15");
    const selected = selectWindowHours([...hours("2026-07-15", "00:00", 24)].reverse(), window);
    expect(selected).toHaveLength(14);
    expect(selected[0]?.timeMs).toBe(window.startMs);
  });
});

describe("label windows are half-open: hours just outside never count", () => {
  const day = "2026-07-15";
  const sunset = madridWallTimeToEpochMs(day, "21:20");

  interface BoundCase {
    chore: OutcomeChore;
    expected: boolean;
    /** The window's hours; `index` is the position inside the window. */
    inside: (index: number) => Partial<HourlyWeather>;
    /** A single hour that would flip the label if it were counted. */
    poison: Partial<HourlyWeather>;
  }
  const cases: BoundCase[] = [
    {
      chore: "plants",
      expected: true,
      inside: () => ({ et0Mm: 0, precipitationMm: 0.1 }),
      poison: { et0Mm: 100, precipitationMm: 0 },
    },
    {
      chore: "plants",
      expected: false,
      inside: () => ({ et0Mm: 1, precipitationMm: 0 }),
      poison: { et0Mm: 0, precipitationMm: 100 },
    },
    {
      chore: "laundry_line",
      expected: true,
      inside: () => ({
        precipitationMm: 0,
        windSpeedKmh: 30,
        relativeHumidityPct: 0,
        sunshineSeconds: 3600,
      }),
      poison: {
        precipitationMm: 5,
        windSpeedKmh: 30,
        relativeHumidityPct: 0,
        sunshineSeconds: 3600,
      },
    },
    {
      chore: "laundry_line",
      expected: false,
      // D = 0.36 per hour: 8 hours sum to 2.88, one more dry hour of D = 1 would reach 3
      inside: () => ({
        precipitationMm: 0,
        windSpeedKmh: 18,
        relativeHumidityPct: 100,
        sunshineSeconds: 1080,
      }),
      poison: {
        precipitationMm: 0,
        windSpeedKmh: 30,
        relativeHumidityPct: 0,
        sunshineSeconds: 3600,
      },
    },
    {
      chore: "laundry_tonight",
      expected: true,
      inside: (index) => ({ temperatureC: 20, dewPointC: index < 2 ? 19 : 5 }),
      poison: { temperatureC: 20, dewPointC: 19 },
    },
    {
      chore: "laundry_tonight",
      expected: false,
      inside: (index) => ({ temperatureC: 20, dewPointC: index < 3 ? 19 : 5 }),
      poison: { temperatureC: 20, dewPointC: 5, precipitationMm: 0 },
    },
    {
      chore: "ac",
      expected: true,
      inside: () => ({ temperatureC: 18 }),
      poison: { temperatureC: 30 },
    },
    {
      chore: "ac",
      expected: false,
      inside: () => ({ temperatureC: 30 }),
      poison: { temperatureC: 10 },
    },
    {
      chore: "heater",
      expected: true,
      inside: () => ({ temperatureC: 25 }),
      poison: { temperatureC: 5 },
    },
    {
      chore: "heater",
      expected: false,
      inside: () => ({ temperatureC: 5 }),
      poison: { temperatureC: 25 },
    },
  ];

  it.each(cases)(
    "$chore stays $expected when the hours around the window say the opposite",
    ({ chore, expected, inside, poison }) => {
      const window = outcomeWindow(chore, day, sunset);
      // independent of windowHourStarts: an hour is inside if it overlaps [startMs, endMs)
      const firstInside = Math.floor(window.startMs / HOUR_MS) * HOUR_MS;
      const series: HourlyWeather[] = [];
      for (
        let timeMs = firstInside - 18 * HOUR_MS;
        timeMs < window.endMs + 18 * HOUR_MS;
        timeMs += HOUR_MS
      ) {
        const isInside = timeMs >= firstInside && timeMs < window.endMs;
        series.push(hour(timeMs, isInside ? inside((timeMs - firstInside) / HOUR_MS) : poison));
      }
      // 36 h of data around the window; the hour before it and the hour at its end are poison
      expect(series.find((h) => h.timeMs === firstInside - HOUR_MS)).toMatchObject(poison);
      expect(series.find((h) => h.timeMs === window.endMs)).toMatchObject(poison);
      expect(outcomeLabel(chore, series, window).delivered).toBe(expected);
    },
  );

  it("names the first missing hour when the window is incomplete", () => {
    const window = outcomeWindow("heater", day);
    const series = hours(day, "08:00", 14).filter((h) => h.timeMs !== window.startMs + 3 * HOUR_MS);
    expect(() => selectWindowHours(series, window)).toThrow(/1 of 14.*2026-07-15T09:00:00.000Z/);
  });
});
