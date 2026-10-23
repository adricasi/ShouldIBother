import type { EvalJobSpec } from "./jobs.js";
import type { CaseRecord } from "./types.js";

/** The target of every eval: at least 19 of 20 (NFR-004), kept as a ratio for sets of other sizes. */
export const TARGET = { numerator: 19, denominator: 20 } as const;
/** Photo judgement, inspector plus bookmaker, within 15 s (NFR-004). */
export const PHOTO_JUDGEMENT_BUDGET_MS = 15_000;

/** How many of `total` must pass: 19 of 20, and the same share of a set of another size. */
export function neededOf(total: number): number {
  return Math.ceil((total * TARGET.numerator) / TARGET.denominator);
}

/** Nearest-rank percentile of an ascending list: the 19th of 20 values is p95. */
export function percentile(sortedAscending: readonly number[], percent: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.max(1, Math.ceil((percent / 100) * sortedAscending.length));
  return sortedAscending[Math.min(rank, sortedAscending.length) - 1]!;
}

export interface Criterion {
  readonly id: "valid_json" | "tool_use" | "photo_judgement_15s";
  readonly label: string;
  readonly count: number;
  readonly total: number;
  readonly needed: number;
  readonly met: boolean;
}

export interface Summary {
  readonly cases: number;
  /** Cases whose own job answered with valid JSON (an `unsure` question counts). */
  readonly primaryValid: number;
  /** Cases where every job of the case was valid (the inspector case also runs the bookmaker). */
  readonly allValid: number;
  /** Valid without the single retry. */
  readonly validFirstTry: number;
  readonly unsure: number;
  /** Failure code to the number of cases that ended with it. */
  readonly failures: Readonly<Record<string, number>>;
  /** The bookmaker's use of `get_forecast`; null when no case ran a bookmaker. */
  readonly toolUse: {
    readonly bookmakerRuns: number;
    readonly called: number;
    readonly injected: number;
    readonly missed: number;
    /** Runs whose very first model reply already carried the tool call. */
    readonly firstAnswerWithTool: number;
  } | null;
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly max: number };
  /** Photo judgement within 15 s; null for jobs without a photo budget. */
  readonly withinPhotoBudget: number | null;
  readonly expectation: { readonly matched: number; readonly total: number } | null;
  readonly criteria: readonly Criterion[];
  readonly targetMet: boolean;
}

function criterion(id: Criterion["id"], label: string, count: number, total: number): Criterion {
  const needed = neededOf(total);
  return { id, label, count, total, needed, met: count >= needed };
}

export function summarize(records: readonly CaseRecord[], spec: EvalJobSpec): Summary {
  const total = records.length;
  const bookmakerSteps = records.flatMap((record) =>
    record.steps.filter((step) => step.job === "bookmaker"),
  );
  const toolUse =
    bookmakerSteps.length === 0
      ? null
      : {
          bookmakerRuns: bookmakerSteps.length,
          called: bookmakerSteps.filter((step) => step.toolMode === "called").length,
          injected: bookmakerSteps.filter((step) => step.toolMode === "injected").length,
          missed: bookmakerSteps.filter(
            (step) => step.toolMode !== "called" && step.toolMode !== "injected",
          ).length,
          firstAnswerWithTool: bookmakerSteps.filter((step) => step.firstAnswerHadToolCall === true)
            .length,
        };
  const times = records.map((record) => record.latencyMs).sort((a, b) => a - b);
  const withinPhotoBudget = spec.photoBudget
    ? records.filter(
        (record) =>
          record.valid &&
          record.steps.some((step) => step.job === "bookmaker") &&
          record.latencyMs <= PHOTO_JUDGEMENT_BUDGET_MS,
      ).length
    : null;
  const primaryValid = records.filter((record) => record.primaryValid).length;

  const criteria: Criterion[] = [
    criterion("valid_json", `Valid JSON (${spec.primaryStep})`, primaryValid, total),
  ];
  if (spec.job === "bookmaker" && toolUse !== null) {
    criteria.push(
      criterion("tool_use", "get_forecast used", toolUse.called + toolUse.injected, total),
    );
  }
  if (withinPhotoBudget !== null) {
    criteria.push(
      criterion(
        "photo_judgement_15s",
        "Photo judgement (inspector + bookmaker) within 15 s",
        withinPhotoBudget,
        total,
      ),
    );
  }

  const failures: Record<string, number> = {};
  for (const record of records) {
    if (record.failure !== null) {
      failures[record.failure] = (failures[record.failure] ?? 0) + 1;
    }
  }
  const expecting = records.filter((record) => record.matchesExpectation !== null);

  return {
    cases: total,
    primaryValid,
    allValid: records.filter((record) => record.valid).length,
    validFirstTry: records.filter((record) => record.valid && record.retries === 0).length,
    unsure: records.filter((record) => record.steps.some((step) => step.status === "unsure"))
      .length,
    failures,
    toolUse,
    latencyMs: {
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: times[times.length - 1] ?? 0,
    },
    withinPhotoBudget,
    expectation:
      expecting.length === 0
        ? null
        : {
            matched: expecting.filter((record) => record.matchesExpectation === true).length,
            total: expecting.length,
          },
    criteria,
    targetMet: total > 0 && criteria.every((entry) => entry.met),
  };
}
