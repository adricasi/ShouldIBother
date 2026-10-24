/**
 * Shared types of the backtest harness (REQ-018, REQ-019 AC-019.3, NFR-005, NFR-012).
 *
 * A strategy sees a `DecisionInput` (what is known at the decision time) and never the outcome:
 * the outcome label is attached by the runner afterwards, so a strategy can not peek at it.
 */

import type { Band } from "../../domain/bands.js";
import type { OutcomeBasis, BacktestChore, TimeWindow } from "../../domain/outcomes.js";
import type { SafetyAlert } from "../../domain/rules/index.js";
import type { ForecastHour } from "../../domain/weather.js";
import type { Split } from "../dataset.js";
import type { DecisionForecast, ForecastQuality } from "../decision-forecast.js";

export const STRATEGY_IDS = ["rule", "fixed", "e2b", "e4b", "e4b-ft"] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export const STRATEGY_LABELS: Readonly<Record<StrategyId, string>> = {
  rule: "Rule baseline",
  fixed: "Fixed routine",
  e2b: "Gemma 4 E2B",
  e4b: "Gemma 4 E4B (base)",
  "e4b-ft": "Gemma 4 E4B (fine-tuned)",
};

export type StrategyKind = "rule" | "fixed" | "gemma";

export function kindOf(id: StrategyId): StrategyKind {
  return id === "rule" ? "rule" : id === "fixed" ? "fixed" : "gemma";
}

/** The household bets on doing nothing ("skip") or does the chore. */
export type Action = "skip" | "do_it";

/**
 * Where a decision's odds came from:
 * - `rule`: the rule baseline strategy.
 * - `gemma`: Gemma's band (the only basis that counts toward Gemma's calibration).
 * - `rule_fallback`: Gemma gave no usable answer, so the rule odds stood (`odds_source = rule`).
 * - `safety_alert`: the fixed heat/frost/storm backstop made it a "Do it now" alert, no odds.
 * - `fixed_routine`: the habit baseline, no odds.
 */
export type DecisionBasis = "rule" | "gemma" | "rule_fallback" | "safety_alert" | "fixed_routine";

/** Why Gemma's answer was not used: a runner failure, or a card the person would have to answer. */
export type GemmaFallbackReason =
  | "internal"
  | "unavailable"
  | "timeout"
  | "deadline"
  | "invalid"
  | "tool_missed"
  | "tool_error"
  | "unsure"
  | "unresolved";

export type ToolModeFact = "called" | "injected" | "missed";

export interface GemmaFacts {
  readonly model: string;
  readonly modelDigest: string | null;
  readonly promptVersion: string;
  readonly toolMode: ToolModeFact | null;
  /**
   * True when the first model answer came without a `get_forecast` call (tools were offered and
   * not used); null when there was no first answer or the app made the call (injected mode).
   */
  readonly firstAnswerWithoutTool: boolean | null;
  readonly calls: number;
  readonly retries: number;
  readonly latencyMs: number;
  readonly failure: GemmaFallbackReason | null;
  /** Gemma's own band, when it gave one (kept for audit even when it was not used). */
  readonly gemmaBand: Band | null;
  /** Bands between Gemma's band and the rule band for its settle time. */
  readonly bandsFromRule: number | null;
}

/** One decision of one strategy on one chore-day, as stored in `decisions.jsonl`. */
export interface DecisionRecord {
  readonly v: 1;
  readonly strategy: StrategyId;
  readonly chore: BacktestChore;
  readonly date: string;
  readonly split: Split;
  readonly action: Action;
  readonly basis: DecisionBasis;
  /** The band the odds stand for; null for the fixed routine and safety alerts. */
  readonly band: Band | null;
  readonly ruleBand: Band;
  /** The outcome label ("the weather delivered"), attached by the runner after the decision. */
  readonly delivered: boolean;
  readonly forecastQuality: ForecastQuality;
  readonly gemma?: GemmaFacts;
}

/** What is known at a chore's fixed decision time. There is no outcome in here. */
export interface DecisionInput {
  readonly chore: BacktestChore;
  readonly date: string;
  readonly decisionAtMs: number;
  /** The day-1-lead forecast with its provenance (model-run start per value). */
  readonly forecast: DecisionForecast;
  /** The same hours in the app's shape, with daylight derived from the sunset. */
  readonly hours: readonly ForecastHour[];
  /** What `get_forecast` serves: day-1 values only, 24 h from the decision hour (see cases.ts). */
  readonly toolForecast: DecisionForecast;
  readonly toolHours: readonly ForecastHour[];
  readonly sunsetMs: number | null;
  /** The rule baseline's window for this decision. */
  readonly ruleWindow: TimeWindow;
  readonly ruleBand: Band;
  /** The fixed backstop fired over the rule window: a "Do it now" alert, no odds. */
  readonly alert: SafetyAlert | null;
}

/** A decision input plus the outcome, which only the runner and the report see. */
export interface BacktestCase {
  readonly key: string;
  readonly split: Split;
  readonly input: DecisionInput;
  readonly delivered: boolean;
  readonly outcomeBasis: OutcomeBasis;
}

export type CaseSkipReason =
  "outside_periods" | "no_sunset" | "incomplete_archive_window" | "no_rule_quote";

export interface CaseSkip {
  readonly chore: BacktestChore;
  readonly date: string;
  readonly reason: CaseSkipReason;
}

export interface Strategy {
  readonly id: StrategyId;
  readonly kind: StrategyKind;
  decide(input: DecisionInput): Promise<StrategyDecision>;
  /** Whether the model runtime answers (Gemma strategies); the run waits on it after an outage. */
  reachable?(): Promise<boolean>;
  /** Frees the GPU when the strategy is done or the run pauses (Gemma strategies). */
  release?(): Promise<void>;
}

/** What a strategy returns; the runner adds the identifiers and the outcome. */
export type StrategyDecision = Omit<
  DecisionRecord,
  "v" | "strategy" | "chore" | "date" | "split" | "delivered" | "forecastQuality" | "ruleBand"
>;

export function caseKey(chore: BacktestChore, date: string): string {
  return `${chore}|${date}`;
}

export function recordKey(strategy: StrategyId, chore: BacktestChore, date: string): string {
  return `${strategy}|${chore}|${date}`;
}
