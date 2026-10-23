/**
 * The backtest report as data (JSON) and as Markdown (REQ-018 AC-018.3, AC-019.3, NFR-012).
 *
 * The headline period is the hold-out (1 Sep to the snapshot's last archive day); Apr-Aug is
 * always labelled in-sample. Everything under `results` and `method` is reproducible from the
 * snapshot and the decisions, so `report.json` is byte-identical on a re-run; the measured model
 * time is written apart (`performance.json`).
 *
 * AC-018.2: the headline tables and the calibration use the days decided on day-1-lead forecasts
 * only. Days that fell back to a short-lead forecast or to recorded weather are in their own
 * labelled breakdown, with their counts.
 */

import { OUTCOME_CHORES, type OutcomeChore } from "../../domain/outcomes.js";
import { madridParts } from "../../domain/time.js";
import type { RulesConfig } from "../../domain/rules/index.js";
import type { SavingsCatalogue } from "../../domain/savings.js";
import type { Split } from "../dataset.js";
import { FORECAST_QUALITY_LABELS, type ForecastQuality } from "../decision-forecast.js";
import { HOLDOUT_START_DATE, TRAINING_END_DATE, TRAINING_START_DATE } from "../target-band.js";
import type { WeatherSnapshot } from "../snapshot.js";

import {
  latencyOf,
  summarisePeriod,
  type Calibration,
  type LatencySummary,
  type PeriodSummary,
} from "./metrics.js";
import {
  ASSUMPTIONS,
  BACKTEST_DRYER,
  FIXED_ROUTINE_DESCRIPTION,
  SKIP_FROM_BAND,
} from "./policy.js";
import { TOOL_HORIZON_HOURS } from "./cases.js";
import {
  STRATEGY_LABELS,
  kindOf,
  type BacktestCase,
  type CaseSkip,
  type DecisionRecord,
  type StrategyId,
  type StrategyKind,
} from "./types.js";

export const REPORT_SCHEMA_VERSION = 1;

/** What the report says about one strategy's model. */
export interface StrategyInfo {
  readonly id: StrategyId;
  /** Ollama tag from `config/models.json`; absent for the rule and the fixed routine. */
  readonly modelTag?: string;
  readonly modelDigest?: string;
}

export interface MethodInfo {
  readonly rulesSha256: string;
  /** The `config/rules.json` values the rule baseline and the backstop used (T-019 lists them). */
  readonly rules: RulesConfig;
  readonly bookmakerPrompt: { readonly version: string; readonly sha256: string };
  readonly model: {
    readonly temperature: number;
    readonly seed: number;
    readonly toolUse: string;
    readonly answerMode: string;
    readonly callTimeoutMs: number;
    readonly deadlineMs: number;
    readonly maxModelCalls: number;
  };
  /** The habits shown to the bookmaker; the values are never printed, only their hash. */
  readonly habits: { readonly entries: number; readonly sha256: string | null };
  readonly savings: SavingsCatalogue;
}

export interface ReportInput {
  readonly complete: boolean;
  readonly fakeModel: boolean;
  readonly snapshot: WeatherSnapshot;
  readonly cases: readonly BacktestCase[];
  readonly skipped: readonly CaseSkip[];
  readonly records: readonly DecisionRecord[];
  readonly strategies: readonly StrategyInfo[];
  readonly method: MethodInfo;
  /** Which periods the run covered. */
  readonly splits: "all" | Split;
}

export interface PeriodInfo {
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly days: number;
}

export interface StrategyReport {
  readonly id: StrategyId;
  readonly label: string;
  readonly kind: StrategyKind;
  readonly model: { readonly tag: string | null; readonly digest: string | null } | null;
  /** Days decided on day-1-lead forecasts: the headline numbers. */
  readonly holdout: PeriodSummary | null;
  readonly inSample: PeriodSummary | null;
  /** Days on a fallback forecast, labelled; never mixed into the numbers above. */
  readonly fallbackForecasts: Readonly<Record<"holdout" | "inSample", FallbackSummaries>>;
}

export type FallbackQuality = Exclude<ForecastQuality, "day1_previous_runs">;
export const FALLBACK_QUALITIES: readonly FallbackQuality[] = [
  "short_lead_forecast_optimistic",
  "perfect_forecast_upper_bound",
];
export type FallbackSummaries = Readonly<Record<FallbackQuality, PeriodSummary | null>>;

export interface BacktestReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly status: "complete" | "partial";
  readonly fakeModel: boolean;
  readonly headline: "holdout";
  readonly snapshot: {
    readonly location: string;
    readonly startDate: string;
    readonly endDate: string;
    readonly requestedEndDate: string;
    readonly fetchedAt: string;
    readonly attribution: string;
    readonly license: string;
    readonly sources: readonly string[];
  };
  readonly periods: { readonly holdout: PeriodInfo | null; readonly inSample: PeriodInfo | null };
  readonly forecastData: Readonly<
    Record<
      "holdout" | "inSample",
      {
        readonly byQuality: Readonly<Record<ForecastQuality, number>>;
        readonly plantsLabelBasis: Readonly<
          Record<"et0_minus_rain" | "rain_only_fallback", number>
        >;
      }
    >
  >;
  readonly daysNotSimulated: Readonly<Record<string, number>>;
  readonly results: readonly StrategyReport[];
  readonly method: MethodInfo & {
    readonly decisionPolicy: string;
    readonly fixedRoutine: Readonly<Record<OutcomeChore, string>>;
    readonly assumptions: readonly string[];
    readonly toolHorizon: string;
    readonly habitsNote: string;
  };
}

/** Measured model time per Gemma strategy (wall-clock, so not reproducible). */
export function buildPerformance(
  records: readonly DecisionRecord[],
  strategies: readonly StrategyInfo[],
): Record<string, LatencySummary> {
  const performance: Record<string, LatencySummary> = {};
  for (const info of strategies) {
    const latency = latencyOf(records.filter((record) => record.strategy === info.id));
    if (latency !== undefined) {
      performance[info.id] = latency;
    }
  }
  return performance;
}

const TOOL_HORIZON_TEXT = `get_forecast serves the hours from the decision hour for ${TOOL_HORIZON_HOURS} hours (the day-1 lead: a value for hour H comes from a run that started 24 h before H), day-1 values only; an hour with no such value is left out, never filled from the Historical Forecast or the archive. That covers every chore's settle bounds (plants run to 12:00 the next day).`;

/** An ISO timestamp as Europe/Madrid wall-clock time. */
export function madridTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  const p = madridParts(ms);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)} Europe/Madrid`;
}

function periodInfo(
  snapshot: WeatherSnapshot,
  cases: readonly BacktestCase[],
  split: Split,
): PeriodInfo | null {
  const dates = cases.filter((c) => c.split === split).map((c) => c.input.date);
  if (dates.length === 0) {
    return null;
  }
  const holdout = split === "holdout";
  return {
    label: holdout
      ? `hold-out, ${HOLDOUT_START_DATE} to ${snapshot.endDate}`
      : `in-sample, ${snapshot.startDate > TRAINING_START_DATE ? snapshot.startDate : TRAINING_START_DATE} to ${TRAINING_END_DATE}`,
    from: dates.reduce((a, b) => (a < b ? a : b)),
    to: dates.reduce((a, b) => (a > b ? a : b)),
    days: new Set(dates).size,
  };
}

function forecastData(
  cases: readonly BacktestCase[],
  split: Split,
): BacktestReport["forecastData"]["holdout"] {
  const own = cases.filter((c) => c.split === split);
  const quality = (q: ForecastQuality): number =>
    own.filter((c) => c.input.forecast.quality === q).length;
  const plants = own.filter((c) => c.input.chore === "plants");
  return {
    byQuality: {
      day1_previous_runs: quality("day1_previous_runs"),
      short_lead_forecast_optimistic: quality("short_lead_forecast_optimistic"),
      perfect_forecast_upper_bound: quality("perfect_forecast_upper_bound"),
    },
    plantsLabelBasis: {
      et0_minus_rain: plants.filter((c) => c.outcomeBasis === "et0_minus_rain").length,
      rain_only_fallback: plants.filter((c) => c.outcomeBasis === "rain_only_fallback").length,
    },
  };
}

export function buildReport(input: ReportInput): BacktestReport {
  const { snapshot, cases, records, method } = input;
  const results: StrategyReport[] = input.strategies.map((info) => {
    const own = records.filter((record) => record.strategy === info.id);
    const kind = kindOf(info.id);
    const context = { rules: method.rules, catalogue: method.savings, kind };
    const period = (split: Split, quality?: FallbackQuality): PeriodSummary | null => {
      const inPeriod = own.filter(
        (record) =>
          record.split === split &&
          (quality === undefined
            ? record.forecastQuality === "day1_previous_runs"
            : record.forecastQuality === quality),
      );
      return inPeriod.length === 0 ? null : summarisePeriod(inPeriod, context);
    };
    const fallbacks = (split: Split): FallbackSummaries => ({
      short_lead_forecast_optimistic: period(split, "short_lead_forecast_optimistic"),
      perfect_forecast_upper_bound: period(split, "perfect_forecast_upper_bound"),
    });
    return {
      id: info.id,
      label: STRATEGY_LABELS[info.id],
      kind,
      model:
        kind === "gemma" ? { tag: info.modelTag ?? null, digest: info.modelDigest ?? null } : null,
      holdout: period("holdout"),
      inSample: period("train"),
      fallbackForecasts: { holdout: fallbacks("holdout"), inSample: fallbacks("train") },
    };
  });

  const notSimulated: Record<string, number> = {};
  for (const skip of input.skipped) {
    notSimulated[skip.reason] = (notSimulated[skip.reason] ?? 0) + 1;
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: input.complete ? "complete" : "partial",
    fakeModel: input.fakeModel,
    headline: "holdout",
    snapshot: {
      location: snapshot.location.name,
      startDate: snapshot.startDate,
      endDate: snapshot.endDate,
      requestedEndDate: snapshot.requestedEndDate,
      fetchedAt: madridTime(snapshot.fetchedAt),
      attribution: snapshot.attribution,
      license: snapshot.license,
      sources: Object.values(snapshot.sources).map((source) => source.baseUrl),
    },
    periods: {
      holdout: periodInfo(snapshot, cases, "holdout"),
      inSample: periodInfo(snapshot, cases, "train"),
    },
    forecastData: {
      holdout: forecastData(cases, "holdout"),
      inSample: forecastData(cases, "train"),
    },
    daysNotSimulated: Object.fromEntries(
      Object.entries(notSimulated).sort(([a], [b]) => a.localeCompare(b)),
    ),
    results,
    method: {
      ...method,
      decisionPolicy: `The simulated household bets on doing nothing when the odds band is at least "${method.rules.bandNames[SKIP_FROM_BAND]}" (${method.rules.bandOdds[SKIP_FROM_BAND]} %) and does the chore otherwise. Safety alerts (heat, frost, storm) are always "do it".`,
      fixedRoutine: FIXED_ROUTINE_DESCRIPTION,
      assumptions: ASSUMPTIONS,
      toolHorizon: TOOL_HORIZON_TEXT,
      habitsNote:
        method.habits.sha256 === null
          ? "The bookmaker was shown no habits (the run used a habits file with {}, as the live app does until onboarding feeds them). The default is the fixed synthetic profile in training/habits.synthetic.json, which the fine-tuned model was trained with."
          : `The bookmaker was shown a habit profile of ${method.habits.entries} entries (sha256 ${method.habits.sha256.slice(0, 12)}); the values are not printed here.`,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const QUALITY_ORDER: readonly ForecastQuality[] = [
  "day1_previous_runs",
  "short_lead_forecast_optimistic",
  "perfect_forecast_upper_bound",
];

function minutes(seconds: number): string {
  const total = Math.round(seconds / 60);
  const sign = total < 0 ? "-" : "";
  const abs = Math.abs(total);
  return abs < 60
    ? `${sign}${abs} min`
    : `${sign}${Math.floor(abs / 60)} h ${String(abs % 60).padStart(2, "0")} min`;
}

function share(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)} %`;
}

function number(value: number | null | undefined, digits = 4): string {
  return value === null || value === undefined ? "n/a" : value.toFixed(digits);
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function resultsTable(
  report: BacktestReport,
  pick: (result: StrategyReport) => PeriodSummary | null,
  note: (result: StrategyReport) => string,
): string[] {
  const rows = report.results.flatMap((result) => {
    const summary = pick(result);
    if (summary === null) {
      return [];
    }
    const savings = summary.savings;
    return [
      [
        `${result.label}${note(result)}`,
        String(summary.decisions),
        String(summary.skips),
        String(summary.skipsThatWorked),
        String(summary.plantRiskDays),
        minutes(savings.timeSavedS),
        result.kind === "fixed" ? "n/a (no app)" : minutes(savings.netTimeS),
        `${savings.waterL} L`,
        `${savings.electricityKwh} kWh`,
      ],
    ];
  });
  return table(
    [
      "Strategy",
      "Decisions",
      "Skips taken",
      "Skips that worked",
      "Plant-risk days",
      "Time saved",
      "Net time (after 30 s per bet)",
      "Water saved",
      "Electricity saved",
    ],
    rows,
  );
}

function calibrationBlock(label: string, calibration: PeriodSummary["calibration"]): string[] {
  if (calibration.status === "n/a") {
    return [`**${label}**: calibration n/a. ${calibration.reason}`, ""];
  }
  const cal: Calibration = calibration;
  const lines = [
    `**${label}** (N = ${cal.n}; ${cal.population})`,
    "",
    ...table(
      ["Band (odds)", "N", "Doing nothing worked", "Share", ""],
      [...cal.bands]
        .reverse()
        .map((row) => [
          `${row.name} (${row.odds} %)`,
          String(row.n),
          String(row.worked),
          share(row.share),
          row.tooFewToJudge ? "too few to judge (N < 5)" : "",
        ]),
    ),
    "",
    `Brier score: ${number(cal.brier)} (N = ${cal.n}; lower is better).` +
      (cal.ruleBrierOnSameCases === undefined
        ? ""
        : ` The rule's Brier score on the same ${cal.n} days: ${number(cal.ruleBrierOnSameCases)}.`),
    "",
  ];
  return lines;
}

function fallbackText(summary: PeriodSummary): string {
  const entries = Object.entries(summary.ruleFallbacks);
  return entries.length === 0
    ? "none"
    : entries.map(([reason, count]) => `${reason} ${count}`).join(", ");
}

function periodSection(
  report: BacktestReport,
  heading: string,
  intro: string,
  pick: (result: StrategyReport) => PeriodSummary | null,
  note: (result: StrategyReport) => string,
): string[] {
  const present = report.results.filter((result) => pick(result) !== null);
  if (present.length === 0) {
    return [heading, "", "No decisions in this period.", ""];
  }
  const lines = [heading, "", intro, "", ...resultsTable(report, pick, note), ""];
  const gemma = present.filter((result) => result.kind === "gemma");
  lines.push("Calibration", "");
  for (const result of present) {
    const summary = pick(result);
    if (summary !== null) {
      lines.push(...calibrationBlock(`${result.label}${note(result)}`, summary.calibration));
    }
  }
  if (gemma.length > 0) {
    lines.push("Tool-call miss rate (answers that came without a `get_forecast` call)", "");
    lines.push(
      ...table(
        [
          "Model",
          "Gemma jobs",
          "First answer without the call",
          "Still without it after the retry",
          "App made the call",
        ],
        gemma.flatMap((result) => {
          const calls = pick(result)?.toolCalls;
          return calls === undefined
            ? []
            : [
                [
                  result.label,
                  String(calls.jobs),
                  `${calls.firstAnswerWithoutTool} (${share(calls.firstAnswerMissRate)})`,
                  `${calls.missedAfterRetry} (${share(calls.missedAfterRetryRate)})`,
                  String(calls.injected),
                ],
              ];
        }),
      ),
      "",
    );
    lines.push(
      "Days a Gemma strategy kept the rule odds (`odds_source = rule`, left out of Gemma's calibration and Brier score): " +
        gemma
          .map((result) => `${result.label}: ${fallbackText(pick(result) ?? emptySummary)}`)
          .join("; ") +
        ".",
      "",
    );
  }
  const alerts = present
    .map((result) => `${result.label}: ${pick(result)?.safetyAlerts ?? 0}`)
    .join("; ");
  lines.push(`"Do it now" safety alerts (no odds, never a skip): ${alerts}.`, "");
  const outside = present.flatMap((result) => {
    const wins = pick(result)?.savings.winsOutsideSeason ?? {};
    const text = Object.entries(wins)
      .map(([chore, count]) => `${chore} ${count}`)
      .join(", ");
    return text === "" ? [] : [`${result.label}: ${text}`];
  });
  if (outside.length > 0) {
    lines.push(
      `Skips that worked outside the chore's savings season (counted as skips that worked, no savings credited): ${outside.join("; ")}.`,
      "",
    );
  }
  return lines;
}

const emptySummary = { ruleFallbacks: {} } as unknown as PeriodSummary;

function fallbackSection(report: BacktestReport): string[] {
  const lines = [
    "## Days on fallback forecasts (labelled; not in the tables above)",
    "",
    "Days where a forecast variable was missing from the day-1-lead data and came from a short-lead source or from recorded weather (AC-018.2).",
    "",
  ];
  let any = false;
  for (const [key, title] of [
    ["holdout", "Hold-out"],
    ["inSample", "In-sample"],
  ] as const) {
    for (const quality of FALLBACK_QUALITIES) {
      const rows = report.results.flatMap((result) => {
        const summary = result.fallbackForecasts[key][quality];
        if (summary === null) {
          return [];
        }
        const cal = summary.calibration;
        return [
          [
            result.label,
            String(summary.decisions),
            String(summary.skips),
            String(summary.skipsThatWorked),
            String(summary.plantRiskDays),
            cal.status === "ok" ? `${number(cal.brier)} (N = ${cal.n})` : "n/a",
          ],
        ];
      });
      if (rows.length > 0) {
        any = true;
        lines.push(
          `**${title}: ${FORECAST_QUALITY_LABELS[quality]}** (${report.forecastData[key].byQuality[quality]} days)`,
          "",
          ...table(
            [
              "Strategy",
              "Decisions",
              "Skips taken",
              "Skips that worked",
              "Plant-risk days",
              "Brier",
            ],
            rows,
          ),
          "",
        );
      }
    }
  }
  if (!any) {
    lines.push("None: every simulated day used day-1-lead forecasts.", "");
  }
  return lines;
}

function choreTable(
  report: BacktestReport,
  pick: (result: StrategyReport) => PeriodSummary | null,
): string[] {
  const present = report.results.filter((result) => pick(result) !== null);
  return table(
    ["Chore", ...present.map((result) => `${result.label}: skips (worked)`)],
    OUTCOME_CHORES.map((chore) => [
      chore,
      ...present.map((result) => {
        const row = pick(result)?.byChore[chore];
        return row === undefined ? "" : `${row.skips} (${row.skipsThatWorked}) of ${row.decisions}`;
      }),
    ]),
  );
}

/** The report for people: the hold-out is the headline, Apr-Aug is labelled in-sample. */
export function renderMarkdown(report: BacktestReport): string {
  const out: string[] = ["# Backtest report", ""];
  if (report.fakeModel) {
    out.push(
      "> **FAKE MODEL.** The Gemma rows were produced by the recorded-fixture model, not by Gemma. They test the pipeline, not the model.",
      "",
    );
  }
  if (report.status === "partial") {
    out.push(
      "> **PARTIAL.** The run is not finished; the numbers cover only the decisions made so far.",
      "",
    );
  }
  const { snapshot } = report;
  out.push(
    `Weather: ${snapshot.location}, ${snapshot.startDate} to ${snapshot.endDate} (the archive's last complete day), Europe/Madrid. Snapshot fetched ${snapshot.fetchedAt}.`,
    "",
    snapshot.attribution,
    "",
    "Every decision uses only forecasts from model runs that started before the chore's fixed decision time (Open-Meteo Previous Runs, day-1 lead). Outcomes come from recorded weather (archive). No photos and no household data are used.",
    "",
  );

  // Forecast quality labels (AC-018.2).
  const quality = (key: "holdout" | "inSample"): string =>
    QUALITY_ORDER.map(
      (q) => `${FORECAST_QUALITY_LABELS[q]}: ${report.forecastData[key].byQuality[q]}`,
    ).join(", ");
  const optimistic = (["holdout", "inSample"] as const).some(
    (key) =>
      report.forecastData[key].byQuality.short_lead_forecast_optimistic > 0 ||
      report.forecastData[key].byQuality.perfect_forecast_upper_bound > 0,
  );
  out.push(
    `Forecast data (days): hold-out: ${quality("holdout")}. In-sample: ${quality("inSample")}.`,
    "",
  );
  if (optimistic) {
    out.push(
      '> Some days could not use day-1-lead forecasts for every variable. The headline tables and the calibration below use the day-1 days only; the other days are in "Days on fallback forecasts" with their label, which must travel with any number quoted from there.',
      "",
    );
  }
  const plantsFallback =
    report.forecastData.holdout.plantsLabelBasis.rain_only_fallback +
    report.forecastData.inSample.plantsLabelBasis.rain_only_fallback;
  if (plantsFallback > 0) {
    out.push(
      `Plants outcome label: ${plantsFallback} days used the rain-only fallback (ET0 was unavailable); the rest use ET0 minus rain.`,
      "",
    );
  }

  const holdout = report.periods.holdout;
  out.push(
    ...periodSection(
      report,
      `## Headline: ${holdout?.label ?? "hold-out (no days in this run)"}`,
      holdout === null
        ? ""
        : `${holdout.days} simulated days (${holdout.from} to ${holdout.to}), one decision per strategy per chore per day. The fine-tuned model never saw these days; the rule thresholds were fixed before them.`,
      (result) => result.holdout,
      () => "",
    ),
  );

  const inSample = report.periods.inSample;
  out.push(
    ...periodSection(
      report,
      `## ${inSample === null ? "In-sample (no days in this run)" : `In-sample (${inSample.label.replace("in-sample, ", "")})`}`,
      "**In-sample, not a fair test**: the rule thresholds were set with this period in view and the fine-tuned model was trained on it. Shown for completeness; the headline is the hold-out.",
      (result) => result.inSample,
      (result) =>
        result.id === "e4b-ft"
          ? " (in-sample: trained on 1 Apr to 30 Aug; the 31 Aug overnight rows were not in training)"
          : result.id === "rule"
            ? " (thresholds in-sample)"
            : "",
    ),
  );

  out.push(...fallbackSection(report));

  out.push("## By chore (hold-out, day-1 days): skips taken (skips that worked) of decisions", "");
  out.push(...choreTable(report, (result) => result.holdout), "");

  out.push("## Method and assumptions", "");
  out.push(
    `- ${report.method.decisionPolicy}`,
    ...report.method.assumptions.map((line) => `- Assumption: ${line}`),
    `- Tool horizon: ${report.method.toolHorizon}`,
    "- Plant-risk day: a day a strategy skipped watering and the plants outcome label was false.",
    "- Fixed routine (the habit baseline, no forecast, no odds):",
    ...OUTCOME_CHORES.map((chore) => `  - ${chore}: ${report.method.fixedRoutine[chore]}`),
    `- Savings assumptions behind the figures (dryer: ${BACKTEST_DRYER}):`,
  );
  const assumptions = new Map<string, string>();
  for (const result of report.results) {
    for (const summary of [result.holdout, result.inSample]) {
      for (const entry of summary?.savings.assumptions ?? []) {
        assumptions.set(`${entry.chore}`, `${entry.chore}: ${entry.assumption} (${entry.basis})`);
      }
    }
  }
  for (const line of [...assumptions.values()].sort()) {
    out.push(`  - ${line}`);
  }
  out.push(
    `- Bookmaker prompt: ${report.method.bookmakerPrompt.version} (sha256 ${report.method.bookmakerPrompt.sha256.slice(0, 12)}).`,
    `- Model settings: temperature ${report.method.model.temperature}, seed ${report.method.model.seed}, tool use ${report.method.model.toolUse}, answer mode ${report.method.model.answerMode}; ${report.method.model.callTimeoutMs / 1000} s per call, ${report.method.model.deadlineMs / 1000} s per job, at most ${report.method.model.maxModelCalls} calls per job.`,
    `- Habits: ${report.method.habitsNote}`,
    "",
    "Models",
    "",
    ...table(
      ["Strategy", "Ollama tag", "Digest"],
      report.results
        .filter((result) => result.kind === "gemma")
        .map((result) => [result.label, result.model?.tag ?? "n/a", result.model?.digest ?? "n/a"]),
    ),
    "",
    `Rule baseline and safety backstop: \`config/rules.json\` (sha256 ${report.method.rulesSha256.slice(0, 12)}), final values, no tuning:`,
    "",
    "```json",
    JSON.stringify(report.method.rules, null, 2),
    "```",
    "",
  );

  const reasons = Object.entries(report.daysNotSimulated);
  out.push("## Days not simulated", "");
  out.push(
    reasons.length === 0
      ? "None."
      : reasons.map(([reason, count]) => `- ${reason}: ${count} chore-days`).join("\n"),
    "",
  );

  return `${out.join("\n")}\n`;
}

export function serializeReport(report: BacktestReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
