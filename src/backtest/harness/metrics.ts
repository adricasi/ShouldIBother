/**
 * What the report counts for one strategy over one period (AC-018.3, AC-019.3): skips, skips that
 * worked (chores avoided), savings on wins, plant-risk days, band calibration with N per band,
 * Brier score and the tool-call miss rate. Pure functions over `DecisionRecord`s.
 */

import { BANDS, type Band } from "../../domain/bands.js";
import { BACKTEST_CHORES, type BacktestChore, type OutcomeChore } from "../../domain/outcomes.js";
import type { RulesConfig } from "../../domain/rules/index.js";
import { snapshotFor, totalSavings, type SavingsCatalogue } from "../../domain/savings.js";

import { BACKTEST_DRYER, inSavingsSeason } from "./policy.js";
import type { DecisionRecord, StrategyKind } from "./types.js";

/** Bands with fewer cases than this count as "too few to judge" (AC-020.2). */
export const MIN_BAND_N = 5;

export interface BandRow {
  readonly band: Band;
  readonly name: string;
  /** The odds the band stands for, in percent. */
  readonly odds: number;
  readonly n: number;
  /** Cases where doing nothing worked (the outcome label was true). */
  readonly worked: number;
  readonly share: number | null;
  readonly tooFewToJudge: boolean;
}

export interface Calibration {
  readonly status: "ok";
  /** Which decisions are in it, in words. */
  readonly population: string;
  readonly n: number;
  readonly bands: readonly BandRow[];
  /** Mean squared difference between the odds (as 0..1) and the outcome; null when n = 0. */
  readonly brier: number | null;
  /** Gemma only: the rule's Brier score on exactly the same cases. */
  readonly ruleBrierOnSameCases?: number | null;
}

export interface NotApplicable {
  readonly status: "n/a";
  readonly reason: string;
}

export interface ToolCallSummary {
  /** Gemma jobs run (days the backstop made an alert run none). */
  readonly jobs: number;
  /** Jobs whose first model answer came without a `get_forecast` call. */
  readonly firstAnswerWithoutTool: number;
  /** Jobs that ended without a valid call after the single retry. */
  readonly missedAfterRetry: number;
  /** Jobs where the app made the call itself (`tool_mode = injected`); not part of the rates. */
  readonly injected: number;
  /** Share of jobs with an answer whose first answer lacked the call; null in injected mode. */
  readonly firstAnswerMissRate: number | null;
  readonly missedAfterRetryRate: number | null;
}

export interface ChoreSummary {
  readonly decisions: number;
  readonly skips: number;
  readonly skipsThatWorked: number;
  readonly plantRiskDays: number;
}

export interface SavingsSummary {
  readonly timeSavedS: number;
  readonly appTimeS: number;
  readonly netTimeS: number;
  readonly waterL: number;
  readonly electricityKwh: number;
  /** Skips that worked outside the chore's savings season: counted, not credited. */
  readonly winsOutsideSeason: Readonly<Record<string, number>>;
  readonly assumptions: readonly {
    readonly chore: OutcomeChore;
    readonly assumption: string;
    readonly basis: string;
    readonly wins: number;
  }[];
}

export interface PeriodSummary {
  readonly days: number;
  readonly decisions: number;
  readonly skips: number;
  readonly skipsThatWorked: number;
  readonly doIts: number;
  readonly safetyAlerts: number;
  /** Gemma days that kept the rule odds, by reason. */
  readonly ruleFallbacks: Readonly<Record<string, number>>;
  readonly plantRiskDays: number;
  readonly savings: SavingsSummary;
  readonly byChore: Readonly<Record<BacktestChore, ChoreSummary>>;
  readonly calibration: Calibration | NotApplicable;
  readonly toolCalls?: ToolCallSummary;
}

export interface MetricsContext {
  readonly rules: RulesConfig;
  readonly catalogue: SavingsCatalogue;
  readonly kind: StrategyKind;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function brierOf(pairs: readonly { odds: number; worked: boolean }[]): number | null {
  if (pairs.length === 0) {
    return null;
  }
  const total = pairs.reduce(
    (sum, { odds, worked }) => sum + (odds / 100 - (worked ? 1 : 0)) ** 2,
    0,
  );
  return round(total / pairs.length, 4);
}

function calibrationOf(
  records: readonly DecisionRecord[],
  context: MetricsContext,
): Calibration | NotApplicable {
  if (context.kind === "fixed") {
    return {
      status: "n/a",
      reason: "The fixed routine has no odds, so there is nothing to calibrate.",
    };
  }
  const gemma = context.kind === "gemma";
  const priced = records.filter((record) =>
    gemma ? record.basis === "gemma" : record.basis === "rule",
  );
  const oddsOf = (band: Band): number => context.rules.bandOdds[band];
  const bands: BandRow[] = BANDS.map((band) => {
    const inBand = priced.filter((record) => record.band === band);
    const worked = inBand.filter((record) => record.delivered).length;
    return {
      band,
      name: context.rules.bandNames[band],
      odds: oddsOf(band),
      n: inBand.length,
      worked,
      share: inBand.length === 0 ? null : round(worked / inBand.length, 3),
      tooFewToJudge: inBand.length < MIN_BAND_N,
    };
  });
  const pairs = priced.flatMap((record) =>
    record.band === null ? [] : [{ odds: oddsOf(record.band), worked: record.delivered }],
  );
  return {
    status: "ok",
    population: gemma
      ? "days Gemma priced itself (rule-odds days, safety alerts and failed answers excluded)"
      : "every day the rule priced (safety alerts excluded)",
    n: priced.length,
    bands,
    brier: brierOf(pairs),
    ...(gemma
      ? {
          ruleBrierOnSameCases: brierOf(
            priced.map((record) => ({ odds: oddsOf(record.ruleBand), worked: record.delivered })),
          ),
        }
      : {}),
  };
}

function toolCallsOf(records: readonly DecisionRecord[]): ToolCallSummary | undefined {
  const jobs = records.flatMap((record) => (record.gemma === undefined ? [] : [record.gemma]));
  if (jobs.length === 0) {
    return undefined;
  }
  const injected = jobs.filter((job) => job.toolMode === "injected").length;
  const withFirst = jobs.filter((job) => job.firstAnswerWithoutTool !== null);
  const firstMisses = withFirst.filter((job) => job.firstAnswerWithoutTool === true).length;
  const judged = jobs.filter((job) => job.toolMode === "called" || job.toolMode === "missed");
  const missed = judged.filter((job) => job.toolMode === "missed").length;
  return {
    jobs: jobs.length,
    firstAnswerWithoutTool: firstMisses,
    missedAfterRetry: missed,
    injected,
    firstAnswerMissRate: withFirst.length === 0 ? null : round(firstMisses / withFirst.length, 4),
    missedAfterRetryRate: judged.length === 0 ? null : round(missed / judged.length, 4),
  };
}

/** The summary of one strategy's decisions over one period. */
export function summarisePeriod(
  records: readonly DecisionRecord[],
  context: MetricsContext,
): PeriodSummary {
  const skips = records.filter((record) => record.action === "skip");
  const wins = skips.filter((record) => record.delivered);
  const byChore = Object.fromEntries(
    BACKTEST_CHORES.map((chore) => {
      const own = records.filter((record) => record.chore === chore);
      const ownSkips = own.filter((record) => record.action === "skip");
      return [
        chore,
        {
          decisions: own.length,
          skips: ownSkips.length,
          skipsThatWorked: ownSkips.filter((record) => record.delivered).length,
          plantRiskDays:
            chore === "plants" ? ownSkips.filter((record) => !record.delivered).length : 0,
        },
      ];
    }),
  ) as Record<BacktestChore, ChoreSummary>;

  // Net time subtracts 30 s per bet or do-it decision made in the app: every decision of an
  // app strategy except a "Do it now" alert (no bet action); the fixed routine uses no app.
  const betsPlaced =
    context.kind === "fixed"
      ? 0
      : records.filter((record) => record.basis !== "safety_alert").length;
  const credited = wins.filter((record) => inSavingsSeason(record.chore, record.date));
  const winsOutsideSeason: Record<string, number> = {};
  for (const record of wins) {
    if (!inSavingsSeason(record.chore, record.date)) {
      winsOutsideSeason[record.chore] = (winsOutsideSeason[record.chore] ?? 0) + 1;
    }
  }
  const totals = totalSavings(
    credited.map((record) =>
      snapshotFor(context.catalogue, record.chore, { dryer: BACKTEST_DRYER }),
    ),
    betsPlaced,
  );
  const fallbacks: Record<string, number> = {};
  for (const record of records) {
    if (record.basis === "rule_fallback") {
      const reason = record.gemma?.failure ?? "unknown";
      fallbacks[reason] = (fallbacks[reason] ?? 0) + 1;
    }
  }
  const toolCalls = context.kind === "gemma" ? toolCallsOf(records) : undefined;
  return {
    days: new Set(records.map((record) => record.date)).size,
    decisions: records.length,
    skips: skips.length,
    skipsThatWorked: wins.length,
    doIts: records.filter((record) => record.action === "do_it").length,
    safetyAlerts: records.filter((record) => record.basis === "safety_alert").length,
    ruleFallbacks: Object.fromEntries(
      Object.entries(fallbacks).sort(([a], [b]) => a.localeCompare(b)),
    ),
    plantRiskDays: byChore.plants.plantRiskDays,
    savings: {
      timeSavedS: totals.time_saved_s,
      appTimeS: totals.app_time_s,
      netTimeS: totals.net_time_s,
      waterL: totals.water_l,
      electricityKwh: totals.electricity_kwh,
      winsOutsideSeason: Object.fromEntries(
        Object.entries(winsOutsideSeason).sort(([a], [b]) => a.localeCompare(b)),
      ),
      assumptions: totals.assumptions.map((entry) => ({
        chore: entry.chore_type,
        assumption: entry.assumption,
        basis: entry.basis,
        wins: entry.wins,
      })),
    },
    byChore,
    calibration: calibrationOf(records, context),
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

export interface LatencySummary {
  readonly jobs: number;
  readonly calls: number;
  readonly meanJobMs: number;
  readonly medianJobMs: number;
  readonly p95JobMs: number;
  readonly meanCallMs: number;
  readonly totalMs: number;
}

/** Measured model time of a Gemma strategy; wall-clock, so not reproducible between runs. */
export function latencyOf(records: readonly DecisionRecord[]): LatencySummary | undefined {
  const jobs = records.flatMap((record) => (record.gemma === undefined ? [] : [record.gemma]));
  if (jobs.length === 0) {
    return undefined;
  }
  const times = jobs.map((job) => job.latencyMs).sort((a, b) => a - b);
  const total = times.reduce((sum, ms) => sum + ms, 0);
  const calls = jobs.reduce((sum, job) => sum + job.calls, 0);
  const at = (fraction: number): number =>
    times[Math.min(times.length - 1, Math.floor(fraction * times.length))] ?? 0;
  return {
    jobs: jobs.length,
    calls,
    meanJobMs: Math.round(total / jobs.length),
    medianJobMs: at(0.5),
    p95JobMs: at(0.95),
    meanCallMs: calls === 0 ? 0 : Math.round(total / calls),
    totalMs: total,
  };
}
