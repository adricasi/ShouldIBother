import { describe, expect, it } from "vitest";

import { madridParts, madridWallTimeToEpochMs } from "../../src/domain/time.js";
import type { ForecastHour } from "../../src/domain/weather.js";
import {
  buildWeatherBoard,
  clockLabel,
  conditionWords,
  lazyThreshold,
} from "../../src/domain/weather-board.js";
import { loadRules } from "../../src/server/rules.js";

const rules = loadRules();
const DATE = "2026-10-22";
const at = (time: string): number => madridWallTimeToEpochMs(DATE, time);

/** A dry, sunny, breezy hour: the line dries (drying index 0.91). */
const DRY = { relativeHumidityPct: 30, windKmh: 30, sunshineSeconds: 3600, precipitationMm: 0 };
/** Still, damp and grey: dry, but not enough for the sky to do the chore (index 0.03). */
const DAMP = { relativeHumidityPct: 90, windKmh: 0, sunshineSeconds: 0, precipitationMm: 0 };

function hour(clock: number, overrides: Partial<ForecastHour> = {}): ForecastHour {
  return {
    startsAt: at(`${String(clock).padStart(2, "0")}:00`),
    precipitationMm: 0,
    precipitationProbabilityPct: 10,
    temperatureC: 20.6,
    dewPointC: 12,
    relativeHumidityPct: 50,
    windKmh: 17.6,
    gustKmh: 25,
    sunshineSeconds: 1800,
    weatherCode: 0,
    isDay: clock >= 7 && clock < 20,
    ...overrides,
  };
}

/** Today from 00:00 to 23:00: damp until 09:00, dry 10:00 to 17:00, rain at 18:00. */
function day(): ForecastHour[] {
  return Array.from({ length: 24 }, (_unused, clock) => {
    if (clock >= 10 && clock < 18) {
      return hour(clock, DRY);
    }
    if (clock === 18) {
      return hour(clock, { ...DRY, precipitationMm: 1.2 });
    }
    return hour(clock, DAMP);
  });
}

describe("T-027: REQ-026 the weather board figures", () => {
  it("AC-026.1: the current hour gives the temperature, condition, rain chance and wind", () => {
    const hours = day().map((entry) => ({ ...entry, windKmh: entry.windKmh === 30 ? 17.6 : 0 }));
    expect(buildWeatherBoard(hours, at("10:41"), rules)).toMatchObject({
      temperatureC: 21,
      condition: "Sunny",
      rainPct: 10,
      windKmh: 18,
    });
  });

  it("AC-026.1: the bars are today's daylight hours, and the lazy ones form the window", () => {
    const board = buildWeatherBoard(day(), at("09:41"), rules)!;
    expect(board.hours.map((entry) => entry.hour)).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    expect(board.hours.filter((entry) => entry.lazy).map((entry) => entry.hour)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    expect(board.lazyWindow).toEqual({ from: "10:00", to: "18:00" });
  });

  it("AC-026.1: a wet hour is a dead bar and never lazy", () => {
    const board = buildWeatherBoard(day(), at("09:41"), rules)!;
    expect(board.hours.find((entry) => entry.hour === 18)).toEqual({
      hour: 18,
      level: 0,
      lazy: false,
    });
  });

  it("AC-026.1: hours already over are not part of the window; the current hour still is", () => {
    const board = buildWeatherBoard(day(), at("14:30"), rules)!;
    expect(board.lazyWindow).toEqual({ from: "14:00", to: "18:00" });
    expect(board.hours.find((entry) => entry.hour === 12)?.lazy).toBe(false);
  });

  it("AC-026.1: no lazy hour left means no window", () => {
    const board = buildWeatherBoard(day(), at("18:30"), rules)!;
    expect(board.lazyWindow).toBeNull();
  });

  it("AC-026.1: the longest dry run is the window when a missing value splits the day", () => {
    const hours = day().map((entry) =>
      madridHour(entry) === 12 ? { ...entry, relativeHumidityPct: null } : entry,
    );
    const board = buildWeatherBoard(hours, at("09:41"), rules)!;
    expect(board.hours.find((entry) => entry.hour === 12)).toEqual({
      hour: 12,
      level: null,
      lazy: false,
    });
    expect(board.lazyWindow).toEqual({ from: "13:00", to: "18:00" });
  });

  it("AC-026.1: no forecast hour covers now: no board", () => {
    expect(buildWeatherBoard([], at("09:41"), rules)).toBeNull();
    expect(buildWeatherBoard(day(), at("09:41") + 48 * 3_600_000, rules)).toBeNull();
  });

  it("missing temperature, wind or code shows as unknown, not as zero", () => {
    const hours = day().map((entry) =>
      madridHour(entry) === 9
        ? { ...entry, temperatureC: null, windKmh: null, weatherCode: null }
        : entry,
    );
    expect(buildWeatherBoard(hours, at("09:41"), rules)).toMatchObject({
      temperatureC: null,
      windKmh: null,
      condition: "No condition",
    });
  });

  it("the lazy threshold is the toss-up row of the line-dry rule, read from the config", () => {
    const tossUp = rules.chores.lineDry.meanDryingIndexRows.filter((row) => row.band === 2);
    expect(tossUp).toHaveLength(1);
    expect(lazyThreshold(rules)).toBe(tossUp[0]?.atLeast);
    // A pinned value too, so a change of the rows is noticed here and decided on purpose.
    expect(lazyThreshold(rules)).toBe(0.3);
    const without = {
      ...rules,
      chores: {
        ...rules.chores,
        lineDry: {
          ...rules.chores.lineDry,
          meanDryingIndexRows: rules.chores.lineDry.meanDryingIndexRows.filter(
            (row) => row.band !== 2,
          ),
        },
      },
    };
    expect(() => lazyThreshold(without)).toThrow(/band 2/);
  });

  it("an hour the rules rate unlikely (index between 0.15 and 0.3) is not lazy", () => {
    // wind 0, humidity 80, sunshine 1800 s: 0.06 + 0.1 = 0.16.
    const hours = day().map((entry) =>
      madridHour(entry) === 12
        ? { ...entry, windKmh: 0, relativeHumidityPct: 80, sunshineSeconds: 1800 }
        : entry,
    );
    const board = buildWeatherBoard(hours, at("09:41"), rules)!;
    const twelve = board.hours.find((entry) => entry.hour === 12)!;
    expect(twelve.level).toBeGreaterThanOrEqual(0.15);
    expect(twelve.level).toBeLessThan(0.3);
    expect(twelve.lazy).toBe(false);
    expect(board.lazyWindow).toEqual({ from: "13:00", to: "18:00" });
  });

  it("the window ends with the line-dry window (18:00), even when the evening stays dry", () => {
    const hours = day().map((entry) =>
      madridHour(entry) === 18 || madridHour(entry) === 19 ? { ...entry, ...DRY } : entry,
    );
    const board = buildWeatherBoard(hours, at("09:41"), rules)!;
    expect(board.hours.find((entry) => entry.hour === 19)).toMatchObject({ lazy: false });
    expect(board.lazyWindow).toEqual({ from: "10:00", to: "18:00" });
  });

  it("DST: on 25 Oct 2026, the 25-hour day, bars and window stay on the wall clock", () => {
    const start = madridWallTimeToEpochMs("2026-10-25", "00:00");
    const hours = Array.from({ length: 25 }, (_unused, index) => {
      const startsAt = start + index * 3_600_000;
      const wall = madridParts(startsAt).hour;
      return { ...hour(wall, wall >= 10 && wall < 18 ? DRY : DAMP), startsAt };
    });
    // 02:00 happens twice and 04:00 is the fifth hour after midnight.
    expect(hours.filter((entry) => madridParts(entry.startsAt).hour === 2)).toHaveLength(2);
    const now = madridWallTimeToEpochMs("2026-10-25", "09:41");
    const board = buildWeatherBoard(hours, now, rules)!;
    const barHours = board.hours.map((entry) => entry.hour);
    expect(barHours).toEqual([...new Set(barHours)]);
    expect(barHours[0]).toBe(7);
    expect(board.lazyWindow).toEqual({ from: "10:00", to: "18:00" });
  });

  it("a run reaching the end of the day would read 00:00, never 24:00", () => {
    // Only reachable if the window ever extended to midnight; the formatter is guarded anyway.
    expect(clockLabel(24)).toBe("00:00");
  });

  it("weather codes read in plain words, with clear nights", () => {
    expect(conditionWords(0, true)).toBe("Sunny");
    expect(conditionWords(0, false)).toBe("Clear");
    expect(conditionWords(2, true)).toBe("Partly cloudy");
    expect(conditionWords(63, true)).toBe("Rain");
    expect(conditionWords(95, true)).toBe("Thunderstorm");
    expect(conditionWords(12345, true)).toBe("No condition");
  });
});

function madridHour(entry: ForecastHour): number {
  return Math.round((entry.startsAt - at("00:00")) / 3_600_000);
}
