import type { ToolMode } from "../server/gemma/runner.js";

import type { LoggedCall } from "./call-log.js";

/** One Gemma job inside a case. A photo case has two: the inspector, then the bookmaker. */
export interface StepRecord {
  readonly job: string;
  /** Schema-valid, accepted by the job's own checks and, for the bookmaker, tool use enforced. */
  readonly valid: boolean;
  /** Why it is not valid: the runner's failure code (invalid, tool_missed, timeout, ...). */
  readonly failure: string | null;
  /** `unsure` is a valid answer: Gemma asked a question. */
  readonly status: "ok" | "unsure" | null;
  readonly toolMode: ToolMode | null;
  /** Whether the model's very first reply came with a tool call; null when no tool was offered. */
  readonly firstAnswerHadToolCall: boolean | null;
  readonly calls: number;
  readonly retries: number;
  /** Job time, retries included, queue wait excluded (the runner's `latencyMs`). */
  readonly latencyMs: number;
  readonly promptVersion: string;
  readonly error: string | null;
  /** The raw final answer, cut to `MAX_OUTPUT_CHARS`. */
  readonly output: string | null;
}

/** The result of one eval case. */
export interface CaseRecord {
  readonly id: string;
  readonly note: string | null;
  readonly steps: readonly StepRecord[];
  /** Every step is valid. */
  readonly valid: boolean;
  /** The first invalid step's failure code. */
  readonly failure: string | null;
  /** The case's own job (the inspector, not the bookmaker that follows it) is valid. */
  readonly primaryValid: boolean;
  /** How the bookmaker used `get_forecast`, when the case ran one. */
  readonly toolMode: ToolMode | null;
  readonly calls: number;
  readonly retries: number;
  /** Total job time of the case: the sum of its steps. */
  readonly latencyMs: number;
  /** What the answer came out as (a band, a verdict, a state, ...), "invalid" when it failed. */
  readonly answerKey: string;
  /** Whether `answerKey` is one of the case's `expect` values; null when the case expects nothing. */
  readonly matchesExpectation: boolean | null;
}

/** A case record with the raw model calls it took, which only `--record-fixtures` reads. */
export interface CaseRun {
  readonly record: CaseRecord;
  readonly calls: readonly LoggedCall[];
}

export const MAX_OUTPUT_CHARS = 600;
