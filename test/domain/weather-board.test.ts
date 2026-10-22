import { describe, expect, it } from "vitest";

import { madridWallTimeToEpochMs } from "../../src/domain/time.js";
import type { ForecastHour } from "../../src/domain/weather.js";
import {
  buildWeatherBoard,
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

  it("the lazy threshold comes from the rules config, not from the board", () => {
    expect(lazyThreshold(rules)).toBe(0.15);
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
