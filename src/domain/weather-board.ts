import { CHORES } from "./chores.js";
import { dryingIndex } from "./outcomes.js";
import type { RulesConfig } from "./rules/schema.js";
import { HOUR_MS, madridDateOf, madridParts } from "./time.js";
import type { ForecastHour } from "./weather.js";

/**
 * The split-flap weather board (REQ-026): what the sky is doing now and when it is doing the
 * chores. Pure and read-only: it reads the cached forecast the odds already use and sets no odds,
 * points or safety (those stay with the bookmaker and the rules).
 */

/** One bar of the board: a daylight hour of today. */
export interface BoardHour {
  /** Madrid wall-clock hour, 0 to 23. */
  readonly hour: number;
  /** How well the sky dries the line in this hour, 0 to 1; null when the forecast lacks a value. */
  readonly level: number | null;
  /** True for an hour in the lazy window: still to come, before the line-dry window ends, and dry enough that the line dries itself. */
  readonly lazy: boolean;
}

/** The lazy window as Madrid clock times, "10:00" to "18:00"; `to` is the end of the last lazy hour. */
export interface LazyWindow {
  readonly from: string;
  readonly to: string;
}

export interface WeatherBoard {
  /** Rounded to whole degrees; null when the hour has no temperature. */
  readonly temperatureC: number | null;
  /** Plain words for the weather code ("Sunny", "Light rain"). */
  readonly condition: string;
  readonly rainPct: number | null;
  readonly windKmh: number | null;
  readonly hours: readonly BoardHour[];
  readonly lazyWindow: LazyWindow | null;
}

const WORDS_BY_CODE: readonly (readonly [readonly number[], string])[] = [
  [[1], "Mostly clear"],
  [[2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Fog"],
  [[51, 53, 55, 56, 57], "Drizzle"],
  [[61, 63, 65, 66, 67], "Rain"],
  [[71, 73, 75, 77, 85, 86], "Snow"],
  [[80, 81, 82], "Showers"],
  [[95, 96, 99], "Thunderstorm"],
];

/** WMO weather code in plain words; clear sky is "Sunny" by day and "Clear" at night. */
export function conditionWords(code: number | null, isDay: boolean | null): string {
  if (code === null) {
    return "No condition";
  }
  if (code === 0) {
    return isDay === false ? "Clear" : "Sunny";
  }
  return WORDS_BY_CODE.find(([codes]) => codes.includes(code))?.[1] ?? "No condition";
}

export function clockLabel(hour: number): string {
  // A run reaching the last hour of the day ends at midnight: "00:00", never "24:00".
  return `${String(hour % 24).padStart(2, "0")}:00`;
}

/** The toss-up band: the lowest band at which the rules rate drying as better than unlikely. */
const LAZY_BAND = 2;

/**
 * The drying index an hour needs to count as lazy: the toss-up row of the line-dry rule, so a lazy
 * bar never means an hour the rules rate "unlikely" or worse. Read from the rules config by band,
 * so the board adds no threshold of its own and follows the config if its rows move. Using one
 * hour's index against a threshold written for a window's mean is the board's own definition.
 */
export function lazyThreshold(config: RulesConfig): number {
  const row = config.chores.lineDry.meanDryingIndexRows.find(
    (candidate) => candidate.band === LAZY_BAND,
  );
  if (row === undefined) {
    throw new Error(`rules.json has no line-dry row for band ${String(LAZY_BAND)}`);
  }
  return row.atLeast;
}

function levelOf(hour: ForecastHour, config: RulesConfig): number | null {
  const { precipitationMm, windKmh, relativeHumidityPct, sunshineSeconds } = hour;
  if (
    precipitationMm === null ||
    windKmh === null ||
    relativeHumidityPct === null ||
    sunshineSeconds === null
  ) {
    return null;
  }
  return dryingIndex(
    { precipitationMm, windSpeedKmh: windKmh, relativeHumidityPct, sunshineSeconds },
    config.dryingIndex,
    config.wetHourMm,
  );
}

/** The longest run of consecutive lazy hours; the first one wins a tie. */
function longestRun(hours: readonly BoardHour[]): LazyWindow | null {
  let best: { start: number; length: number } | undefined;
  let run: { start: number; length: number } | undefined;
  for (const entry of hours) {
    if (!entry.lazy) {
      run = undefined;
      continue;
    }
    run =
      run !== undefined && run.start + run.length === entry.hour
        ? { start: run.start, length: run.length + 1 }
        : { start: entry.hour, length: 1 };
    if (best === undefined || run.length > best.length) {
      best = run;
    }
  }
  return best === undefined
    ? null
    : { from: clockLabel(best.start), to: clockLabel(best.start + best.length) };
}

/**
 * The board for `nowMs`: the current hour's figures and today's daylight hours as bars, with the
 * lazy window marked. Null when the forecast has no hour covering now.
 */
export function buildWeatherBoard(
  forecast: readonly ForecastHour[],
  nowMs: number,
  config: RulesConfig,
): WeatherBoard | null {
  const current = forecast.find(
    (hour) => hour.startsAt <= nowMs && nowMs < hour.startsAt + HOUR_MS,
  );
  if (current === undefined) {
    return null;
  }
  const threshold = lazyThreshold(config);
  // The lazy window is the line-dry window: hours that start before its end (18:00 Madrid).
  const windowEndMs = CHORES.laundry_line.ruleWindow(nowMs).toMs;
  const today = madridDateOf(nowMs);
  const hours: BoardHour[] = forecast
    .filter((hour) => hour.isDay === true && madridDateOf(hour.startsAt) === today)
    .sort((a, b) => a.startsAt - b.startsAt)
    .map((hour) => {
      const level = levelOf(hour, config);
      return {
        hour: madridParts(hour.startsAt).hour,
        level,
        lazy:
          level !== null &&
          level >= threshold &&
          hour.startsAt + HOUR_MS > nowMs &&
          hour.startsAt < windowEndMs,
      };
    });
  return {
    temperatureC: current.temperatureC === null ? null : Math.round(current.temperatureC),
    condition: conditionWords(current.weatherCode, current.isDay),
    rainPct: current.precipitationProbabilityPct,
    windKmh: current.windKmh === null ? null : Math.round(current.windKmh),
    hours,
    lazyWindow: longestRun(hours),
  };
}
