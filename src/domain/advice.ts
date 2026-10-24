import { HOUR_MS, madridDateOf, madridParts } from "./time.js";
import type { ForecastHour } from "./weather.js";

/**
 * Advice cards (REQ-031, design.md "Advice cards"): the four chores whose answer is not a bet but
 * "do it now", "wait for <window>" or "no good window in the next 3 days". The rule advice and the
 * contradiction checks live here as pure functions of the forecast; Gemma's advisor job reads the
 * same forecast through `get_forecast` and its answer is checked against these rules.
 *
 * Every function takes `hours`: the forecast from the hour the card was created in, index 0 being that
 * hour (what `get_forecast` returns), so a window `{start, end}` in hours ahead means the hours
 * with index `start` up to, not including, `end`.
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
  /** A wet hour has at least this much rain. */
  readonly wetHourMm: number;
  /** A "do it now" is the window [0, nowHours) when it is checked against the forecast. */
  readonly nowHours: number;
  readonly windowsClean: {
    /** Any wet hour in the lookahead makes it wait until `settleHours` after the last one. */
    readonly lookaheadHours: number;
    readonly settleHours: number;
    /** How long the rule's "wait" window is. */
    readonly waitWindowHours: number;
  };
  readonly balconySweep: {
    readonly gustKmhAtLeast: number;
    readonly lookaheadHours: number;
    readonly settleHours: number;
    readonly waitWindowHours: number;
  };
  readonly outdoorPaint: {
    /** The run of hours with no wet hour, humidity under the cap and warm enough. */
    readonly runHours: number;
    readonly humidityPctBelow: number;
    readonly tempCAtLeast: number;
  };
  readonly lawnFeed: {
    /** A spell of consecutive wet hours with at least this much rain, starting in the lookahead. */
    readonly spellMmAtLeast: number;
    readonly lookaheadHours: number;
    readonly waitWindowHours: number;
  };
}

function rainOf(hour: ForecastHour): number {
  return hour.precipitationMm ?? 0;
}

function isWet(hour: ForecastHour, rules: AdviceRules): boolean {
  return rainOf(hour) >= rules.wetHourMm;
}

function waitFrom(start: number, length: number): Advice {
  return { advice: "wait", window: { startHoursAhead: start, endHoursAhead: start + length } };
}

/** Index of the last wet hour among the first `lookahead` hours, or -1. */
function lastWetIndex(
  hours: readonly ForecastHour[],
  lookahead: number,
  rules: AdviceRules,
): number {
  return hours.slice(0, lookahead).findLastIndex((hour) => isWet(hour, rules));
}

/**
 * Rain spells of the lawn rule: runs of consecutive wet hours that start within the lookahead and
 * add up to the threshold. `end` is the index of the hour after the spell.
 */
function lawnSpells(
  hours: readonly ForecastHour[],
  rules: AdviceRules,
): { start: number; end: number }[] {
  const { lookaheadHours, spellMmAtLeast } = rules.lawnFeed;
  const spells: { start: number; end: number }[] = [];
  let index = 0;
  while (index < Math.min(lookaheadHours, hours.length)) {
    if (!isWet(hours[index]!, rules)) {
      index += 1;
      continue;
    }
    const start = index;
    let total = 0;
    while (index < hours.length && isWet(hours[index]!, rules)) {
      total += rainOf(hours[index]!);
      index += 1;
    }
    // Forecast rain comes in tenths of a millimetre: the sum may be a hair under its true value.
    if (total + 1e-6 >= spellMmAtLeast) {
      spells.push({ start, end: index });
    }
  }
  return spells;
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
 * - Clean windows: any wet hour in 0-48 h → wait until 6 h after the last wet hour.
 * - Sweep balcony: gusts of 40 km/h or more in the next 24 h → wait until 3 h after the last one.
 * - Paint outdoors: the first run of 24 h with no wet hour, humidity under 85 % and 10 °C or more
 *   → do it then (now when it starts now); none in the 72 hours → no window.
 * - Feed lawn: a spell of consecutive wet hours adding up to 10 mm or more that starts in 0-48 h →
 *   wait until after it (the last such spell).
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
      const last = lastWetIndex(hours, spec.lookaheadHours, rules);
      return last < 0
        ? { advice: "do_now" }
        : waitFrom(last + 1 + spec.settleHours, spec.waitWindowHours);
    }
    case "lawn_feed": {
      const last = lawnSpells(hours, rules).at(-1);
      if (last === undefined) {
        return { advice: "do_now" };
      }
      return last.end >= Math.min(hours.length, ADVICE_HORIZON_HOURS)
        ? { advice: "no_window" }
        : waitFrom(last.end, rules.lawnFeed.waitWindowHours);
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

/** The window an advice stands for: its own, or [0, nowHours) for "do it now"; none for "no window". */
export function adviceWindowOf(answer: Advice, rules: AdviceRules): AdviceWindow | undefined {
  if (answer.advice === "wait") {
    return answer.window;
  }
  return answer.advice === "do_now"
    ? { startHoursAhead: 0, endHoursAhead: rules.nowHours }
    : undefined;
}

/**
 * Why the forecast contradicts Gemma's answer, as a message for the retry, or undefined when it
 * does not (AC-031.2). A "do it now" is checked as the window [0, 3) h. A "no window" is
 * contradicted when the rule finds a window.
 *
 * | Chore | A window is contradicted when |
 * |---|---|
 * | Clean windows | it contains a wet hour, or starts before the last wet hour of the next 48 h |
 * | Sweep balcony | any hour of the whole window has gusts of 40 km/h or more |
 * | Paint outdoors | any hour in [start, start + 24) is wet, humid (85 % or more) or below 10 °C, or start + 24 is past 72 h |
 * | Feed lawn | it starts before a rain spell (consecutive wet hours, 10 mm or more, starting in 0-48 h) ends |
 */
export function adviceContradiction(
  chore: AdviceChore,
  hours: readonly ForecastHour[],
  answer: Advice,
  rules: AdviceRules,
): string | undefined {
  if (answer.advice === "no_window") {
    const rule = ruleAdvice(chore, hours, rules);
    if (rule.advice === "no_window") {
      return undefined;
    }
    return rule.window === undefined
      ? "saying there is no good window is contradicted: the forecast allows doing it now"
      : `saying there is no good window is contradicted: the forecast has a good window from hour ${String(rule.window.startHoursAhead)} ahead`;
  }
  const window = adviceWindowOf(answer, rules);
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
      const last = lastWetIndex(hours, rules.windowsClean.lookaheadHours, rules);
      return last >= start
        ? `${label} starts before the last wet hour of the next ${String(rules.windowsClean.lookaheadHours)} hours (hour ${String(last)} ahead)`
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
      const run = rules.outdoorPaint.runHours;
      if (start + run > ADVICE_HORIZON_HOURS) {
        return `${label} leaves less than ${String(run)} hours before the ${String(ADVICE_HORIZON_HOURS)} hours end`;
      }
      const bad = firstWhere(hours, start, start + run, (hour) => !paintFit(hour, rules));
      return bad === undefined
        ? undefined
        : `${label} has an hour that is wet, humid or cold for paint (hour ${String(bad)} ahead)`;
    }
    case "lawn_feed": {
      const spell = lawnSpells(hours, rules).find((candidate) => start < candidate.end);
      return spell === undefined
        ? undefined
        : `${label} starts before the heavy rain ends (hours ${String(spell.start)}-${String(spell.end)} ahead)`;
    }
  }
}

export interface AdviceChoreSpec {
  /** The card title. */
  readonly title: string;
  /** The words for doing it, e.g. "Clean the windows". */
  readonly action: string;
  /** The chore in the safety guard's words. */
  readonly judgeName: string;
  /** The headline of "no good window in the next 72 h". */
  readonly noWindow: string;
  /** "after" for a chore that waits for something to pass, "from" for paint that waits for a run. */
  readonly connector: "after" | "from";
}

export const ADVICE_CHORES: Readonly<Record<AdviceChore, AdviceChoreSpec>> = {
  windows_clean: {
    judgeName: "clean the windows",
    title: "Clean the windows",
    action: "Clean the windows",
    noWindow: "No good time to clean the windows in the next 72 h",
    connector: "after",
  },
  balcony_sweep: {
    judgeName: "sweep the balcony",
    title: "Sweep the balcony",
    action: "Sweep the balcony",
    noWindow: "No good time to sweep the balcony in the next 72 h",
    connector: "after",
  },
  outdoor_paint: {
    judgeName: "paint or varnish outdoors",
    title: "Paint or varnish outdoors",
    action: "Paint or varnish outdoors",
    noWindow: "No good window to paint outdoors in the next 72 h",
    connector: "from",
  },
  lawn_feed: {
    judgeName: "feed the lawn",
    title: "Feed the lawn",
    action: "Feed the lawn",
    noWindow: "No good time to feed the lawn in the next 72 h",
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
        ? `Rule: rain in the next ${String(spec.lookaheadHours)} hours; wait until ${String(spec.settleHours)} hours after the last wet hour.`
        : `Rule: no rain in the next ${String(spec.lookaheadHours)} hours.`;
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
      const spell = `a rain spell of ${String(spec.spellMmAtLeast)} mm or more`;
      return answer.advice === "do_now"
        ? `Rule: no ${spell} in the next ${String(spec.lookaheadHours)} hours.`
        : answer.advice === "no_window"
          ? `Rule: ${spell} runs past the ${String(ADVICE_HORIZON_HOURS)} hours.`
          : `Rule: ${spell} in the next ${String(spec.lookaheadHours)} hours; wait until it has passed.`;
    }
  }
}
