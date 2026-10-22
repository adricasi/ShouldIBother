/**
 * The estimate printed per model before the long run starts (NFR-005): decisions still to make
 * times model calls per decision times the latency measured on this machine.
 */

import type { DecisionRecord, StrategyId } from "./types.js";
import { MAX_MODEL_CALLS } from "../../server/gemma/runner.js";

/** NFR-005: the whole backtest completes in at most 8 hours. */
export const BACKTEST_BUDGET_MS = 8 * 3_600_000;

export interface ModelEstimate {
  readonly strategy: StrategyId;
  readonly label: string;
  /** Decisions still to make for this model. */
  readonly remaining: number;
  /** Gemma jobs the estimate is measured on (0: nothing to measure yet). */
  readonly measuredJobs: number;
  readonly callsPerDecision: number;
  readonly msPerCall: number;
  readonly expectedMs: number;
  /** Every remaining decision uses all four calls of the retry budget. */
  readonly worstCaseMs: number;
}

/** `remaining` decisions, measured on the Gemma jobs already recorded for the strategy. */
export function estimateModel(
  strategy: StrategyId,
  label: string,
  recorded: readonly DecisionRecord[],
  remaining: number,
): ModelEstimate {
  const jobs = recorded.flatMap((record) => (record.gemma === undefined ? [] : [record.gemma]));
  const calls = jobs.reduce((sum, job) => sum + job.calls, 0);
  const latency = jobs.reduce((sum, job) => sum + job.latencyMs, 0);
  const callsPerDecision = jobs.length === 0 ? 0 : calls / jobs.length;
  const msPerCall = calls === 0 ? 0 : latency / calls;
  return {
    strategy,
    label,
    remaining,
    measuredJobs: jobs.length,
    callsPerDecision: Math.round(callsPerDecision * 100) / 100,
    msPerCall: Math.round(msPerCall),
    expectedMs: Math.round(remaining * callsPerDecision * msPerCall),
    worstCaseMs: Math.round(remaining * MAX_MODEL_CALLS * msPerCall),
  };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** The lines printed before the run: one per model and the total against the 8 h budget. */
export function renderEstimate(
  estimates: readonly ModelEstimate[],
  budgetMs: number = BACKTEST_BUDGET_MS,
): string[] {
  if (estimates.length === 0) {
    return ["Estimate: no Gemma model to run."];
  }
  const lines = [
    "Estimate (decisions to go x model calls per decision x measured latency per call):",
  ];
  for (const estimate of estimates) {
    lines.push(
      estimate.remaining === 0
        ? `  ${estimate.label}: nothing left to run.`
        : estimate.measuredJobs === 0
          ? `  ${estimate.label}: ${estimate.remaining} decisions, no latency measured yet.`
          : `  ${estimate.label}: ${estimate.remaining} decisions x ${estimate.callsPerDecision} calls x ${(estimate.msPerCall / 1000).toFixed(1)} s = ${formatDuration(estimate.expectedMs)} (worst case with every retry: ${formatDuration(estimate.worstCaseMs)}; measured on ${estimate.measuredJobs} decisions).`,
    );
  }
  const expected = estimates.reduce((sum, estimate) => sum + estimate.expectedMs, 0);
  const worst = estimates.reduce((sum, estimate) => sum + estimate.worstCaseMs, 0);
  lines.push(
    `  Total: ${formatDuration(expected)} expected, ${formatDuration(worst)} worst case, against the ${formatDuration(budgetMs)} budget (NFR-005).`,
  );
  if (expected > budgetMs) {
    lines.push("  WARNING: the expected time is over the budget.");
  } else if (worst > budgetMs) {
    lines.push("  Note: only the worst case is over the budget.");
  }
  return lines;
}
