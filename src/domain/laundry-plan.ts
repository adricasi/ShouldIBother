import type { Band } from "./bands.js";
import type { InstantWindow } from "./chores.js";
import { lineDryFacts, ruleQuote, type RulesConfig } from "./rules/index.js";
import { HOUR_MS, addDays, madridDateOf, madridWallTimeToEpochMs } from "./time.js";
import { hoursInWindow, windowIsCovered, type ForecastHour } from "./weather.js";

/**
 * The laundry planner (REQ-021): Gemma scores the drying weather of the next 4 days and says
 * wash today, skip today or no good day. Everything here is computed by code from the forecast
 * and the clock; Gemma only names a state and a band for each day.
 */

/** The planner looks at today and the three days after it (AC-021.1). */
export const PLAN_DAY_COUNT = 4;
export const PLAN_DAY_KEYS = ["day_0", "day_1", "day_2", "day_3"] as const;
export type PlanDayKey = (typeof PLAN_DAY_KEYS)[number];

export const PLAN_STATES = ["wash_today", "skip_today", "no_good_day"] as const;
export type PlanState = (typeof PLAN_STATES)[number];

/** What the card says for each state (AC-021.1). */
export const PLAN_HEADLINES: Readonly<Record<PlanState, string>> = {
  wash_today: "Wash today",
  skip_today: "Skip today",
  no_good_day: "No good day",
};

/** Hours of forecast the planner reads, from the current hour: 4 days. */
export const PLAN_FORECAST_HOURS = PLAN_DAY_COUNT * 24;

/** Washing is dried on the line between these hours, as in the line-dry outcome label. */
export const DRYING_FROM = "10:00";
export const DRYING_TO = "18:00";

/** The four Madrid dates the planner scores, starting with the day of `anchorMs`. */
export function planDates(anchorMs: number): string[] {
  const today = madridDateOf(anchorMs);
  return PLAN_DAY_KEYS.map((_key, offset) => addDays(today, offset));
}

/** "Thursday": the weekday of a Madrid calendar date, in English like the rest of the app. */
export function weekdayOf(date: string): string {
  const noon = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(noon);
}

/**
 * The hours a load can dry on `date`: 10:00 to 18:00, and for a day already begun only what is
 * left of it. Null when nothing is left (today after 18:00).
 */
export function dryingWindow(date: string, nowMs: number): InstantWindow | null {
  const toMs = madridWallTimeToEpochMs(date, DRYING_TO);
  const fromMs = Math.max(madridWallTimeToEpochMs(date, DRYING_FROM), nowMs);
  return fromMs < toMs ? { fromMs, toMs } : null;
}

/** When a Skip today bet settles: 18:00 on the chosen day (design.md, Settle-time bounds). */
export function planSettleAt(date: string): number {
  return madridWallTimeToEpochMs(date, DRYING_TO);
}

/**
 * The weather a Skip today bet is judged on, and the window its lucky-win label looks at: the
 * drying hours of the chosen day, 10:00 to 18:00 (`settleAtMs` is 18:00 of that day).
 */
export function planBetWindow(settleAtMs: number): InstantWindow {
  return {
    fromMs: madridWallTimeToEpochMs(madridDateOf(settleAtMs), DRYING_FROM),
    toMs: settleAtMs,
  };
}

/** What the planner is told about one day; every number is computed here (AC-021.1). */
export interface PlanDayFacts {
  readonly key: PlanDayKey;
  readonly date: string;
  readonly weekday: string;
  /** Null when no drying hours are left on the day. */
  readonly window: InstantWindow | null;
  /** False when the forecast does not cover the whole window: the day cannot be priced. */
  readonly covered: boolean;
  readonly hours: number;
  readonly rainMm: number | null;
  readonly wetHours: number | null;
  readonly maxRainProbabilityPct: number | null;
  readonly tempMaxC: number | null;
  readonly windMeanKmh: number | null;
  readonly humidityMeanPct: number | null;
  readonly sunshineH: number | null;
  /** Mean drying index D over the window's daylight hours, 0 to 1. */
  readonly dryingIndex: number | null;
  /** The line-dry rule's band for the window: the baseline stored on a Skip today bet. */
  readonly ruleBand: Band | null;
  readonly ruleReason: string | null;
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function present(hours: readonly ForecastHour[], pick: (hour: ForecastHour) => number | null) {
  return hours.map(pick).filter((value): value is number => value !== null);
}

const total = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0);

/** Facts of every planned day from the forecast hours; `anchorMs` is when the card was made. */
export function planDayFacts(
  forecast: readonly ForecastHour[],
  anchorMs: number,
  nowMs: number,
  config: RulesConfig,
): PlanDayFacts[] {
  return planDates(anchorMs).map((date, index) => {
    const key = PLAN_DAY_KEYS[index]!;
    const base = { key, date, weekday: weekdayOf(date) };
    const window = dryingWindow(date, nowMs);
    const empty = {
      hours: 0,
      rainMm: null,
      wetHours: null,
      maxRainProbabilityPct: null,
      tempMaxC: null,
      windMeanKmh: null,
      humidityMeanPct: null,
      sunshineH: null,
      dryingIndex: null,
      ruleBand: null,
      ruleReason: null,
    };
    if (window === null) {
      return { ...base, window, covered: true, ...empty };
    }
    if (!windowIsCovered(forecast, window.fromMs, window.toMs)) {
      return { ...base, window, covered: false, ...empty };
    }
    const hours = hoursInWindow(forecast, window.fromMs, window.toMs);
    const rain = present(hours, (hour) => hour.precipitationMm);
    const probability = present(hours, (hour) => hour.precipitationProbabilityPct);
    const temperature = present(hours, (hour) => hour.temperatureC);
    const wind = present(hours, (hour) => hour.windKmh);
    const humidity = present(hours, (hour) => hour.relativeHumidityPct);
    const sunshine = present(hours, (hour) => hour.sunshineSeconds);
    const facts = lineDryFacts(forecast, window.fromMs, window.toMs, config);
    const quote = ruleQuote("laundry_line", forecast, window.fromMs, window.toMs, config);
    return {
      ...base,
      window,
      covered: true,
      hours: hours.length,
      rainMm: rain.length === 0 ? null : round(total(rain), 1),
      wetHours: rain.length === 0 ? null : rain.filter((mm) => mm >= config.wetHourMm).length,
      maxRainProbabilityPct: probability.length === 0 ? null : Math.max(...probability),
      tempMaxC: temperature.length === 0 ? null : round(Math.max(...temperature), 1),
      windMeanKmh: wind.length === 0 ? null : round(total(wind) / wind.length, 0),
      humidityMeanPct: humidity.length === 0 ? null : round(total(humidity) / humidity.length, 0),
      sunshineH: sunshine.length === 0 ? null : round(total(sunshine) / 3600, 1),
      dryingIndex: facts === null ? null : round(facts.meanDryingIndex, 2),
      ruleBand: quote?.band ?? null,
      ruleReason: quote?.reason ?? null,
    };
  });
}

/** Odds are locked only from a forecast at most this old (AC-014.2: a forecast is reused for 1 h). */
export const PLAN_MAX_FORECAST_AGE_MS = HOUR_MS;

/**
 * A plan can no longer be turned into a bet when the forecast behind it is more than an hour old,
 * or the chosen day's drying hours have begun (10:00): the person plans the wash again.
 */
export function planIsStale(
  forecastAtMs: number | null,
  bestDay: string | null,
  nowMs: number,
): boolean {
  if (forecastAtMs === null || bestDay === null) {
    return true;
  }
  return (
    nowMs - forecastAtMs > PLAN_MAX_FORECAST_AGE_MS ||
    nowMs >= madridWallTimeToEpochMs(bestDay, DRYING_FROM)
  );
}

/** Why following Wash today earned no points (the view shows matching words). */
export type AdviceReason = "not_best_day" | "too_late" | "daily_cap";

/**
 * Whether following Wash today at `followedAtMs` can earn the +5 (AC-021.3): the plan said Wash
 * today on its own best drying day, and the person follows before 18:00 on that day. Null: it can;
 * the once-a-day cap is checked separately.
 */
export function adviceIneligible(
  state: PlanState | null,
  bestDay: string | null,
  followedAtMs: number,
): Exclude<AdviceReason, "daily_cap"> | null {
  if (state !== "wash_today" || bestDay === null || bestDay !== madridDateOf(followedAtMs)) {
    return "not_best_day";
  }
  return followedAtMs >= planSettleAt(bestDay) ? "too_late" : null;
}
