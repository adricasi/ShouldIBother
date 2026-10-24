import { HOUR_MS, madridDateOf, madridParts } from "./time.js";
import type { ForecastHour } from "./weather.js";

/**
 * Advice cards (REQ-031, design.md "Advice cards"): the four chores whose answer is not a bet but
 * "do it now", "wait for <window>" or "no good window in the next 3 days". The rule advice and the
 * contradiction checks live here as pure functions of the forecast; Gemma's advisor job reads the
 * same forecast through `get_forecast` and its answer is checked against these rules.
 *
 * Every function takes `hours`: the forecast from the current hour on, index 0 being the hour that
 * contains now (what `get_forecast` returns), so a window `{start, end}` in hours ahead means the
 * hours with index `start` up to, not including, `end`.
 */

export const ADVICE_CHORE_TYPES = [
  "windows_clean",
  "balcony_sweep",
  "outdoor_paint",
  "lawn_feed",
] as const;
export type AdviceChore = (typeof ADVICE_CHORE_TYPES)[number];

export function isAdviceChore(value: unknown): value is AdviceChore {
  return ADVICE_CHORE_TYPES.some((type) => type === value);
}

export const ADVICE_KINDS = ["do_now", "wait", "no_window"] as const;
export type AdviceKind = (typeof ADVICE_KINDS)[number];

/** Hours ahead of the first forecast hour: the window is `[startHoursAhead, endHoursAhead)`. */
export interface AdviceWindow {
  readonly startHoursAhead: number;
  readonly endHoursAhead: number;
}

/** An advice, Gemma's or the rule's. Only `wait` has a window. */
export interface Advice {
  readonly advice: AdviceKind;
  readonly window?: AdviceWindow;
}

/** The advisor looks 72 hours ahead ("no good window in the next 3 days"). */
export const ADVICE_HORIZON_HOURS = 72;
/** Fewer forecast hours than this cannot decide any of the rules (the longest looks 48 h ahead). */
export const ADVICE_MIN_FORECAST_HOURS = 48;

/**
 * The fixed values of the rules (design.md, Advice cards), read from `config/advice-rules.json`.
 * Final for this version, no tuning; `config/rules.json` is not touched.
 */
export interface AdviceRules {
  /** A wet hour has at least this much rain (the same value as `wetHourMm` in config/rules.json). */
  readonly wetHourMm: number;
  readonly windowsClean: {
    /** Rain in the lookahead at or above this total makes it wait. */
    readonly rainMmAtLeast: number;
    readonly lookaheadHours: number;
    /** Wait until this many hours after the end of the last wet hour. */
    readonly settleHours: number;
    /** How long the rule's "wait" window is, and how long a "do it now" lasts when checked. */
    readonly waitWindowHours: number;
    readonly nowHours: number;
  };
  readonly balconySweep: {
    readonly gustKmhAtLeast: number;
    readonly lookaheadHours: number;
    readonly settleHours: number;
    readonly waitWindowHours: number;
    readonly nowHours: number;
  };
  readonly outdoorPaint: {
    /** The run of hours with no wet hour, humidity under the cap and warm enough. */
    readonly runHours: number;
    readonly humidityPctBelow: number;
    readonly tempCAtLeast: number;
  };
  readonly lawnFeed: {
    readonly rainMmAtLeast: number;
    readonly lookaheadHours: number;
    readonly waitWindowHours: number;
    readonly nowHours: number;
  };
}

function rainOf(hour: ForecastHour): number {
  return hour.precipitationMm ?? 0;
}

function isWet(hour: ForecastHour, rules: AdviceRules): boolean {
  return rainOf(hour) >= rules.wetHourMm;
}

function totalRain(hours: readonly ForecastHour[]): number {
  return hours.reduce((sum, hour) => sum + rainOf(hour), 0);
}

/** Index of the last hour that is wet; with no hour that wet, the last with any rain; else -1. */
function lastRainIndex(hours: readonly ForecastHour[], rules: AdviceRules): number {
  const wet = hours.findLastIndex((hour) => isWet(hour, rules));
  return wet >= 0 ? wet : hours.findLastIndex((hour) => rainOf(hour) > 0);
}

function waitFrom(start: number, length: number): Advice {
  return { advice: "wait", window: { startHoursAhead: start, endHoursAhead: start + length } };
}

/** The last hour of a rain spell that makes the rule wait (clean windows, feed lawn), if there is one. */
function rainSpellEnd(
  chore: "windows_clean" | "lawn_feed",
  hours: readonly ForecastHour[],
  rules: AdviceRules,
): { lastHour: number } | undefined {
  const spec = chore === "windows_clean" ? rules.windowsClean : rules.lawnFeed;
  const ahead = hours.slice(0, spec.lookaheadHours);
  // Forecast rain comes in tenths of a millimetre: the sum may be a hair under its true value.
  if (totalRain(ahead) + 1e-6 < spec.rainMmAtLeast) {
    return undefined;
  }
  const lastHour = lastRainIndex(ahead, rules);
  return lastHour < 0 ? undefined : { lastHour };
}

/** True when an hour is fit for outdoor paint: dry, not humid, warm enough. A missing value is not fit. */
function paintFit(hour: ForecastHour, rules: AdviceRules): boolean {
  return (
    hour.precipitationMm !== null &&
    hour.relativeHumidityPct !== null &&
    hour.temperatureC !== null &&
    !isWet(hour, rules) &&
    hour.relativeHumidityPct < rules.outdoorPaint.humidityPctBelow &&
    hour.temperatureC >= rules.outdoorPaint.tempCAtLeast
  );
}

/**
 * The rule advice for a chore (design.md, Advice cards): computed for every advice card, shown
 * beside Gemma's when they differ, and the whole answer when Gemma has none.
 *
 * - Clean windows: rain of 1 mm or more in the next 48 h → wait until 6 h after the last wet hour.
 * - Sweep balcony: gusts of 40 km/h or more in the next 24 h → wait until 3 h after the last one.
 * - Paint outdoors: the first run of 24 h with no wet hour, humidity under 85 % and 10 °C or more
 *   → do it then (now when it starts now); none in the forecast → no window.
 * - Feed lawn: 10 mm or more in the next 48 h → wait until after the rain.
 *
 * "After the last hour" is counted from the end of that hour. The numbers are in `rules`.
 */
export function ruleAdvice(
  chore: AdviceChore,
  hours: readonly ForecastHour[],
  rules: AdviceRules,
): Advice {
  switch (chore) {
    case "windows_clean": {
      const spec = rules.windowsClean;
      const spell = rainSpellEnd(chore, hours, rules);
      return spell === undefined
        ? { advice: "do_now" }
        : waitFrom(spell.lastHour + 1 + spec.settleHours, spec.waitWindowHours);
    }
    case "lawn_feed": {
      const spell = rainSpellEnd(chore, hours, rules);
      return spell === undefined
        ? { advice: "do_now" }
        : waitFrom(spell.lastHour + 1, rules.lawnFeed.waitWindowHours);
    }
    case "balcony_sweep": {
      const spec = rules.balconySweep;
      const lastGust = hours
        .slice(0, spec.lookaheadHours)
        .findLastIndex((hour) => (hour.gustKmh ?? 0) >= spec.gustKmhAtLeast);
      return lastGust < 0
        ? { advice: "do_now" }
        : waitFrom(lastGust + 1 + spec.settleHours, spec.waitWindowHours);
    }
    case "outdoor_paint": {
      const run = rules.outdoorPaint.runHours;
      const horizon = hours.slice(0, ADVICE_HORIZON_HOURS);
      for (let start = 0; start + run <= horizon.length; start += 1) {
        if (horizon.slice(start, start + run).every((hour) => paintFit(hour, rules))) {
          return start === 0 ? { advice: "do_now" } : waitFrom(start, run);
        }
      }
      return { advice: "no_window" };
    }
  }
}

/** Two advices that mean the same to a person: the same kind and, for a wait, a start within 3 h. */
const SAME_START_WITHIN_HOURS = 3;

export function advicesDiffer(a: Advice, b: Advice): boolean {
  if (a.advice !== b.advice) {
    return true;
  }
  if (a.advice !== "wait" || a.window === undefined || b.window === undefined) {
    return false;
  }
  return Math.abs(a.window.startHoursAhead - b.window.startHoursAhead) >= SAME_START_WITHIN_HOURS;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function range(window: AdviceWindow): string {
  return `${String(window.startHoursAhead)}-${String(window.endHoursAhead)} h ahead`;
}

/** The first hour index in `[from, to)` with the given property, or undefined. */
function firstWhere(
  hours: readonly ForecastHour[],
  from: number,
  to: number,
  test: (hour: ForecastHour) => boolean,
): number | undefined {
  for (let index = Math.max(from, 0); index < Math.min(to, hours.length); index += 1) {
    if (test(hours[index]!)) {
      return index;
    }
  }
  return undefined;
}

/** How long a "do it now" lasts when it is checked against the forecast, in hours. */
function nowHours(chore: AdviceChore, rules: AdviceRules): number {
  switch (chore) {
    case "windows_clean":
      return rules.windowsClean.nowHours;
    case "balcony_sweep":
      return rules.balconySweep.nowHours;
    case "outdoor_paint":
      return rules.outdoorPaint.runHours;
    case "lawn_feed":
      return rules.lawnFeed.nowHours;
  }
}

/** The window a check looks at: the answer's own window, or the first hours for a "do it now". */
function checkedWindow(
  chore: AdviceChore,
  answer: Advice,
  rules: AdviceRules,
): AdviceWindow | undefined {
  if (answer.advice === "wait") {
    return answer.window;
  }
  return answer.advice === "do_now"
    ? { startHoursAhead: 0, endHoursAhead: nowHours(chore, rules) }
    : undefined;
}

/**
 * Why the forecast contradicts Gemma's answer, as a message for the retry, or undefined when it
 * does not (AC-031.2). "No window" is never contradicted: it is shown beside the rule's advice
 * when they differ. A "do it now" is checked as a window starting now.
 *
 * | Chore | A window is contradicted when |
 * |---|---|
 * | Clean windows | it contains a wet hour, or starts before the last wet hour of the next 48 h (when that rain is 1 mm or more) |
 * | Sweep balcony | it contains an hour with gusts of 40 km/h or more |
 * | Paint outdoors | any hour in its first 24 h is wet, humid (85 % or more) or below 10 °C |
 * | Feed lawn | it lies before the end of a rain spell of 10 mm or more in the next 48 h |
 */
export function adviceContradiction(
  chore: AdviceChore,
  hours: readonly ForecastHour[],
  answer: Advice,
  rules: AdviceRules,
): string | undefined {
  const window = checkedWindow(chore, answer, rules);
  if (window === undefined) {
    return undefined;
  }
  const { startHoursAhead: start, endHoursAhead: end } = window;
  const label = answer.advice === "do_now" ? "doing it now" : `your window (${range(window)})`;
  if (start >= hours.length) {
    return `${label} starts after the ${String(hours.length)} forecast hours you were given`;
  }
  switch (chore) {
    case "windows_clean": {
      const wet = firstWhere(hours, start, end, (hour) => isWet(hour, rules));
      if (wet !== undefined) {
        return `${label} contains a wet hour (hour ${String(wet)} ahead, ${String(rainOf(hours[wet]!))} mm)`;
      }
      const spell = rainSpellEnd(chore, hours, rules);
      return spell !== undefined && start <= spell.lastHour
        ? `${label} starts before the last wet hour of the next ${String(rules.windowsClean.lookaheadHours)} hours (hour ${String(spell.lastHour)} ahead)`
        : undefined;
    }
    case "balcony_sweep": {
      const gust = firstWhere(
        hours,
        start,
        end,
        (hour) => (hour.gustKmh ?? 0) >= rules.balconySweep.gustKmhAtLeast,
      );
      return gust === undefined
        ? undefined
        : `${label} contains an hour with gusts of ${String(hours[gust]!.gustKmh)} km/h (hour ${String(gust)} ahead)`;
    }
    case "outdoor_paint": {
      const bad = firstWhere(
        hours,
        start,
        Math.min(end, start + rules.outdoorPaint.runHours),
        (hour) => !paintFit(hour, rules),
      );
      return bad === undefined
        ? undefined
        : `${label} has an hour that is wet, humid or cold for paint (hour ${String(bad)} ahead)`;
    }
    case "lawn_feed": {
      const spell = rainSpellEnd(chore, hours, rules);
      return spell !== undefined && start <= spell.lastHour
        ? `${label} lies before the end of the heavy rain of the next ${String(rules.lawnFeed.lookaheadHours)} hours (last wet hour ${String(spell.lastHour)} ahead)`
        : undefined;
    }
  }
}

export interface AdviceChoreSpec {
  /** The card title. */
  readonly title: string;
  /** The words for doing it, e.g. "Clean the windows". */
  readonly action: string;
  /** The headline of "no good window in the next 3 days". */
  readonly noWindow: string;
  /** "after" for a chore that waits for something to pass, "from" for paint that waits for a run. */
  readonly connector: "after" | "from";
}

export const ADVICE_CHORES: Readonly<Record<AdviceChore, AdviceChoreSpec>> = {
  windows_clean: {
    title: "Clean the windows",
    action: "Clean the windows",
    noWindow: "No good time to clean the windows in the next 3 days",
    connector: "after",
  },
  balcony_sweep: {
    title: "Sweep the balcony",
    action: "Sweep the balcony",
    noWindow: "No good time to sweep the balcony in the next 3 days",
    connector: "after",
  },
  outdoor_paint: {
    title: "Paint or varnish outdoors",
    action: "Paint or varnish outdoors",
    noWindow: "No good window to paint outdoors in the next 3 days",
    connector: "from",
  },
  lawn_feed: {
    title: "Feed the lawn",
    action: "Feed the lawn",
    noWindow: "No good time to feed the lawn in the next 3 days",
    connector: "after",
  },
};

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Europe/Madrid" });

/** "today 14:00", "tomorrow 07:00" or "Thursday 14:00": a Madrid time as a person says it. */
export function whenLabel(epochMs: number, nowMs: number): string {
  const time = madridParts(epochMs);
  const clock = `${pad(time.hour)}:${pad(time.minute)}`;
  const day = madridDateOf(epochMs);
  const today = madridDateOf(nowMs);
  if (day === today) {
    return `today ${clock}`;
  }
  if (day === madridDateOf(nowMs + 24 * HOUR_MS)) {
    return `tomorrow ${clock}`;
  }
  return `${WEEKDAY.format(epochMs)} ${clock}`;
}

/**
 * The headline of an advice: "Clean the windows after Thursday 14:00". `firstHourMs` is the start
 * of forecast hour 0, which the window is counted from.
 */
export function adviceHeadline(
  chore: AdviceChore,
  answer: Advice,
  firstHourMs: number,
  nowMs: number,
): string {
  const spec = ADVICE_CHORES[chore];
  switch (answer.advice) {
    case "do_now":
      return `${spec.action} now`;
    case "no_window":
      return spec.noWindow;
    case "wait": {
      const start = answer.window?.startHoursAhead ?? 0;
      return `${spec.action} ${spec.connector} ${whenLabel(firstHourMs + start * HOUR_MS, nowMs)}`;
    }
  }
}

/** One line that says why the rule gave this advice, with the rule's fixed numbers (AC-031.2). */
export function ruleReason(chore: AdviceChore, answer: Advice, rules: AdviceRules): string {
  const waits = answer.advice === "wait";
  switch (chore) {
    case "windows_clean": {
      const spec = rules.windowsClean;
      return waits
        ? `Rule: ${String(spec.rainMmAtLeast)} mm of rain or more in the next ${String(spec.lookaheadHours)} hours; wait until ${String(spec.settleHours)} hours after the last wet hour.`
        : `Rule: under ${String(spec.rainMmAtLeast)} mm of rain in the next ${String(spec.lookaheadHours)} hours.`;
    }
    case "balcony_sweep": {
      const spec = rules.balconySweep;
      return waits
        ? `Rule: gusts of ${String(spec.gustKmhAtLeast)} km/h or more in the next ${String(spec.lookaheadHours)} hours; wait until ${String(spec.settleHours)} hours after the last one.`
        : `Rule: no gusts of ${String(spec.gustKmhAtLeast)} km/h or more in the next ${String(spec.lookaheadHours)} hours.`;
    }
    case "outdoor_paint": {
      const spec = rules.outdoorPaint;
      const fit = `dry, under ${String(spec.humidityPctBelow)}% humidity and ${String(spec.tempCAtLeast)} °C or warmer`;
      return answer.advice === "no_window"
        ? `Rule: no ${String(spec.runHours)} hours in a row that are ${fit} in the next ${String(ADVICE_HORIZON_HOURS)} hours.`
        : `Rule: ${waits ? "the first" : "the next"} ${String(spec.runHours)} hours that are ${fit}${waits ? " start then" : ""}.`;
    }
    case "lawn_feed": {
      const spec = rules.lawnFeed;
      return waits
        ? `Rule: ${String(spec.rainMmAtLeast)} mm of rain or more in the next ${String(spec.lookaheadHours)} hours; wait until it has passed.`
        : `Rule: under ${String(spec.rainMmAtLeast)} mm of rain in the next ${String(spec.lookaheadHours)} hours.`;
    }
  }
}
