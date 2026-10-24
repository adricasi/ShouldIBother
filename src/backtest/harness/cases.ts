/**
 * The simulated days: one case per chore and Madrid date, with what is known at the chore's fixed
 * decision time (the day-1-lead forecast, the rule band, the safety backstop) kept apart from the
 * outcome label (AC-018.1).
 */

import { CHORES } from "../../domain/chores.js";
import {
  DECISION_TIMES,
  HOUR_MS,
  IncompleteWeatherError,
  BACKTEST_CHORES,
  dateRange,
  decisionTimeMs,
  outcomeLabel,
  type BacktestChore,
  type TimeWindow,
} from "../../domain/outcomes.js";
import { madridParts } from "../../domain/time.js";
import { ruleWindowAt } from "../../server/ledger/chore-rules.js";
import { ruleQuote, safetyAlert, type RulesConfig } from "../../domain/rules/index.js";
import type { ForecastHour } from "../../domain/weather.js";
import { splitOf } from "../dataset.js";
import {
  LookaheadError,
  assertIssuedBefore,
  decisionForecast,
  windowFor,
  type DecisionForecast,
  type FallbackPolicy,
  type ForecastHour as ProvenancedHour,
  type ForecastSource,
} from "../decision-forecast.js";
import type { WeatherVariable } from "../open-meteo.js";
import { archiveHours, type WeatherSnapshot } from "../snapshot.js";

import { caseKey, type BacktestCase, type CaseSkip, type DecisionInput } from "./types.js";

/** Every variable `get_forecast` shows Gemma; the rule and the backstop read the same hours. */
export const TOOL_VARIABLES: readonly WeatherVariable[] = [
  "temperature_2m",
  "dew_point_2m",
  "relative_humidity_2m",
  "precipitation",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_gusts_10m",
  "weather_code",
  "sunshine_duration",
];

/**
 * How far ahead `get_forecast` can see in the backtest: 24 hours from the decision hour. A day-1
 * value for hour H comes from a run that started 24 h before H, so hours from decision + 24 h on
 * were not issued yet. The live tool serves up to 48 hours; the day-1 lead limits the backtest
 * to these 24, which cover every chore's settle bounds (plants run to 12:00 the next day).
 * `sib dataset` (T-031) must build the tool result of its rows the same way.
 */
export const TOOL_HORIZON_HOURS = 24;

/**
 * The hours `get_forecast` serves at the decision: from the decision hour for
 * `TOOL_HORIZON_HOURS`, day-1-lead values only. An hour with no such value is left out; it is
 * never filled from the Historical Forecast or the archive.
 */
export function toolForecastOf(
  snapshot: WeatherSnapshot,
  chore: BacktestChore,
  date: string,
  decisionAtMs: number,
): DecisionForecast {
  const startMs = Math.floor(decisionAtMs / HOUR_MS) * HOUR_MS;
  return decisionForecast(snapshot, chore, date, {
    variables: TOOL_VARIABLES,
    fallback: "none",
    window: { startMs, endMs: decisionAtMs + TOOL_HORIZON_HOURS * HOUR_MS },
  });
}

export interface BuildCasesOptions {
  /** First and last Madrid date to simulate (inclusive); default: the whole snapshot. */
  readonly from?: string;
  readonly to?: string;
  /**
   * What fills a forecast value that has no day-1 value. The backtest accepts the labelled
   * fallbacks (the default); the fine-tune dataset passes "none", so nothing but a model run
   * started before the decision reaches a prompt (AC-018.1, AGENTS.md).
   */
  readonly fallback?: FallbackPolicy;
}

export interface BuiltCases {
  readonly cases: readonly BacktestCase[];
  readonly skipped: readonly CaseSkip[];
}

/**
 * Daylight of an hour. The snapshot has the sunset of each day but no `is_day` column or sunrise:
 * an hour counts as daylight when it starts before that day's sunset and at or after 08:00. The
 * line-dry rule, the only reader of daylight, looks at 09:00-18:00, where this is exact.
 * Unknown (null) when the sunset of the day is missing.
 */
export function daylightOf(snapshot: WeatherSnapshot, hourMs: number): boolean | null {
  const parts = madridParts(hourMs);
  const date = `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const sunsetMs = snapshot.sunsetMsByDate[date];
  if (sunsetMs === undefined) {
    return null;
  }
  return parts.hour >= 8 && hourMs < sunsetMs;
}

function valueOf(hour: ProvenancedHour, variable: WeatherVariable): number | null {
  return hour.values[variable]?.value ?? null;
}

/** The decision forecast in the app's `ForecastHour` shape (what the rule and `get_forecast` read). */
export function toAppHours(
  snapshot: WeatherSnapshot,
  hours: readonly ProvenancedHour[],
): ForecastHour[] {
  return hours.map((hour) => ({
    startsAt: hour.timeMs,
    precipitationMm: valueOf(hour, "precipitation"),
    precipitationProbabilityPct: valueOf(hour, "precipitation_probability"),
    temperatureC: valueOf(hour, "temperature_2m"),
    dewPointC: valueOf(hour, "dew_point_2m"),
    relativeHumidityPct: valueOf(hour, "relative_humidity_2m"),
    windKmh: valueOf(hour, "wind_speed_10m"),
    gustKmh: valueOf(hour, "wind_gusts_10m"),
    sunshineSeconds: valueOf(hour, "sunshine_duration"),
    weatherCode: valueOf(hour, "weather_code"),
    isDay: daylightOf(snapshot, hour.timeMs),
  }));
}

/**
 * The window the rule baseline reads for a decision, as the live app computes it
 * (`CHORES[chore].ruleWindow`); plants run to the settle time, which `settleAtMs` replaces.
 */
export function ruleWindowOf(
  chore: BacktestChore,
  decisionAtMs: number,
  sunsetMs: number | null,
  settleAtMs?: number,
): TimeWindow {
  // The live app's own window (T-013 gave it the card's sunset for laundry tonight).
  const window = ruleWindowAt(
    chore,
    decisionAtMs,
    settleAtMs ?? CHORES[chore].ruleSettleAt(decisionAtMs),
    sunsetMs ?? undefined,
  );
  return { startMs: window.fromMs, endMs: window.toMs };
}

/** The rule band over a window; undefined when the forecast does not cover it. */
export function ruleBandFor(
  input: Pick<DecisionInput, "chore" | "hours">,
  window: TimeWindow,
  rules: RulesConfig,
): { band: DecisionInput["ruleBand"]; reason: string } | undefined {
  const quote = ruleQuote(input.chore, input.hours, window.startMs, window.endMs, rules);
  return quote === null ? undefined : { band: quote.band, reason: quote.reason };
}

/**
 * Builds the cases of a snapshot, date by date. A day is skipped (and counted by reason) when it
 * is outside the Apr-Oct periods, the archive can not label it, or the forecast can not price it;
 * every strategy then plays exactly the same days.
 */
export function buildCases(
  snapshot: WeatherSnapshot,
  rules: RulesConfig,
  options: BuildCasesOptions = {},
): BuiltCases {
  const recorded = archiveHours(snapshot);
  const first =
    options.from !== undefined && options.from > snapshot.startDate
      ? options.from
      : snapshot.startDate;
  const last =
    options.to !== undefined && options.to < snapshot.endDate ? options.to : snapshot.endDate;
  const cases: BacktestCase[] = [];
  const skipped: CaseSkip[] = [];

  for (const date of dateRange(first, last)) {
    for (const chore of BACKTEST_CHORES) {
      const skip = (reason: CaseSkip["reason"]): void => {
        skipped.push({ chore, date, reason });
      };
      const split = splitOf(date, snapshot.endDate);
      if (split === undefined) {
        skip("outside_periods");
        continue;
      }
      const sunsetMs = snapshot.sunsetMsByDate[date] ?? null;
      // Laundry tonight starts at sunset and line-dry reads daylight (from the sunset).
      if ((chore === "laundry_tonight" || chore === "laundry_line") && sunsetMs === null) {
        skip("no_sunset");
        continue;
      }

      let label;
      try {
        label = outcomeLabel(chore, recorded, windowFor(snapshot, chore, date));
      } catch (error) {
        if (error instanceof IncompleteWeatherError) {
          skip("incomplete_archive_window");
          continue;
        }
        throw error;
      }

      const forecast = decisionForecast(snapshot, chore, date, {
        variables: TOOL_VARIABLES,
        ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
      });
      const hours = toAppHours(snapshot, forecast.hours);
      const decisionAtMs = forecast.decisionAtMs;
      const toolForecast = toolForecastOf(snapshot, chore, date, decisionAtMs);
      const ruleWindow = ruleWindowOf(chore, decisionAtMs, sunsetMs);
      const rule = ruleBandFor({ chore, hours }, ruleWindow, rules);
      if (rule === undefined) {
        skip("no_rule_quote");
        continue;
      }
      const input: DecisionInput = {
        chore,
        date,
        decisionAtMs,
        forecast,
        hours,
        toolForecast,
        toolHours: toAppHours(
          snapshot,
          toolForecast.hours.filter((hour) => Object.keys(hour.values).length > 0),
        ),
        sunsetMs,
        ruleWindow,
        ruleBand: rule.band,
        alert: safetyAlert(hours, ruleWindow.startMs, ruleWindow.endMs, rules),
      };
      cases.push({
        key: caseKey(chore, date),
        split,
        input,
        delivered: label.delivered,
        outcomeBasis: label.basis,
      });
    }
  }
  return { cases, skipped };
}

const DAY1_ONLY: ReadonlySet<ForecastSource> = new Set<ForecastSource>(["previous_runs_day1"]);

/** The decision time every chore has (design.md, Outcome labels); a case at any other time is lookahead. */
export class DecisionTimeError extends Error {
  constructor(chore: BacktestChore, date: string, atMs: number) {
    super(
      `${chore} on ${date}: decision at ${new Date(atMs).toISOString()} is not the fixed ${DECISION_TIMES[chore]} Madrid time`,
    );
    this.name = "DecisionTimeError";
  }
}

/**
 * The guard in front of every strategy (AC-018.1): the decision is at the chore's fixed time, no
 * forecast value comes from a model run that started at or after it, and no forecast hour reaches
 * past the day-1 horizon of the decision. Throws `LookaheadError` or `DecisionTimeError`.
 */
export function assertNoLookahead(input: DecisionInput): void {
  if (input.decisionAtMs !== decisionTimeMs(input.chore, input.date)) {
    throw new DecisionTimeError(input.chore, input.date, input.decisionAtMs);
  }
  assertIssuedBefore(input.forecast.hours, input.decisionAtMs, DAY1_ONLY);
  assertIssuedBefore(input.toolForecast.hours, input.decisionAtMs, DAY1_ONLY);
  for (const hour of input.toolForecast.hours) {
    for (const [variable, value] of Object.entries(hour.values)) {
      // The tool serves day-1 values only.
      if (value.source !== "previous_runs_day1") {
        throw new LookaheadError(variable, hour.timeMs, value.issuedAtMs, input.decisionAtMs);
      }
    }
  }
  // The app-shaped hours must be exactly the hours that carry provenance.
  const withProvenance = new Set(input.forecast.hours.map((hour) => hour.timeMs));
  for (const hour of input.hours) {
    if (!withProvenance.has(hour.startsAt)) {
      throw new Error(
        `${input.chore} on ${input.date}: forecast hour ${new Date(hour.startsAt).toISOString()} has no model-run provenance`,
      );
    }
  }
}
