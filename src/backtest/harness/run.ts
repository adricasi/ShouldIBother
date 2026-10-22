/**
 * The run loop: strategy by strategy (so Ollama loads each model once), day by day, with every
 * finished decision appended to the store before the next one starts. Resumable (finished
 * decisions are skipped), paused at a clock time between decisions, with progress lines and the
 * per-model estimate printed before the long part starts (NFR-005).
 */

import { assertNoLookahead } from "./cases.js";
import { BACKTEST_BUDGET_MS, estimateModel, formatDuration, renderEstimate } from "./estimate.js";
import type { DecisionStore } from "./store.js";
import {
  STRATEGY_LABELS,
  recordKey,
  type BacktestCase,
  type DecisionRecord,
  type Strategy,
} from "./types.js";

export type SplitSelection = "all" | "train" | "holdout";

export interface RunOptions {
  readonly cases: readonly BacktestCase[];
  readonly strategies: readonly Strategy[];
  readonly store: DecisionStore;
  readonly splits?: SplitSelection;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /** Stop between decisions once this instant has passed (`--pause-at`). */
  readonly pauseAtMs?: number;
  /** Decisions measured per Gemma model before the estimate is printed. */
  readonly probe?: number;
  /** Print the estimate and stop. */
  readonly estimateOnly?: boolean;
  /** A progress line every this many decisions of a strategy (and at its start and end). */
  readonly progressEvery?: number;
  readonly budgetMs?: number;
}

export type RunStatus = "complete" | "paused" | "estimate_only";

export interface RunOutcome {
  readonly status: RunStatus;
  /** Decisions still to make over all strategies. */
  readonly remaining: number;
}

const DEFAULT_PROBE = 3;
const DEFAULT_PROGRESS_EVERY = 25;

function selected(cases: readonly BacktestCase[], splits: SplitSelection): BacktestCase[] {
  return cases.filter((c) => splits === "all" || c.split === splits);
}

function toRecord(
  strategy: Strategy,
  c: BacktestCase,
  decision: Awaited<ReturnType<Strategy["decide"]>>,
): DecisionRecord {
  return {
    v: 1,
    strategy: strategy.id,
    chore: c.input.chore,
    date: c.input.date,
    split: c.split,
    action: decision.action,
    basis: decision.basis,
    band: decision.band,
    ruleBand: c.input.ruleBand,
    delivered: c.delivered,
    forecastQuality: c.input.forecast.quality,
    ...(decision.gemma === undefined ? {} : { gemma: decision.gemma }),
  };
}

export async function runBacktest(options: RunOptions): Promise<RunOutcome> {
  const { store, log } = options;
  const now = options.now ?? Date.now;
  const wanted = selected(options.cases, options.splits ?? "all");
  const probeTarget = options.probe ?? DEFAULT_PROBE;
  const every = Math.max(1, options.progressEvery ?? DEFAULT_PROGRESS_EVERY);

  const todoOf = (strategy: Strategy): BacktestCase[] =>
    wanted.filter((c) => !store.has(recordKey(strategy.id, c.input.chore, c.input.date)));
  const remainingTotal = (): number =>
    options.strategies.reduce((sum, strategy) => sum + todoOf(strategy).length, 0);
  const paused = (): boolean => options.pauseAtMs !== undefined && now() >= options.pauseAtMs;

  const decide = async (strategy: Strategy, c: BacktestCase): Promise<void> => {
    // The guard runs on every decision, whatever the strategy: a forecast value from a model run
    // that started at or after the decision time stops the run (AC-018.1).
    assertNoLookahead(c.input);
    const decision = await strategy.decide(c.input);
    store.append(toRecord(strategy, c, decision));
  };

  const recordsOf = (strategy: Strategy): DecisionRecord[] =>
    store.records().filter((record) => record.strategy === strategy.id);

  log(
    `Backtest: ${wanted.length} days x ${options.strategies.length} strategies (${options.strategies
      .map((strategy) => STRATEGY_LABELS[strategy.id])
      .join(", ")}); ${remainingTotal()} decisions to make.`,
  );

  const gemma = options.strategies.filter((strategy) => strategy.kind === "gemma");
  const simple = options.strategies.filter((strategy) => strategy.kind !== "gemma");

  // Rule and fixed routine take no time and need no model.
  if (options.estimateOnly !== true) {
    for (const strategy of simple) {
      for (const c of todoOf(strategy)) {
        await decide(strategy, c);
      }
    }
  }

  // Measure each model on its first few decisions (they are real decisions and are kept), then
  // print the estimate before the long part starts.
  for (const strategy of gemma) {
    for (const c of todoOf(strategy)) {
      const measured = recordsOf(strategy).filter((record) => record.gemma !== undefined).length;
      if (measured >= probeTarget) {
        break;
      }
      if (paused()) {
        log(
          `[${STRATEGY_LABELS[strategy.id]}] paused while measuring; run the same command again to resume.`,
        );
        return { status: "paused", remaining: remainingTotal() };
      }
      await decide(strategy, c);
    }
  }
  for (const line of renderEstimate(
    gemma.map((strategy) =>
      estimateModel(
        strategy.id,
        STRATEGY_LABELS[strategy.id],
        recordsOf(strategy),
        todoOf(strategy).length,
      ),
    ),
    options.budgetMs ?? BACKTEST_BUDGET_MS,
  )) {
    log(line);
  }
  if (options.estimateOnly === true) {
    return { status: "estimate_only", remaining: remainingTotal() };
  }

  for (const strategy of gemma) {
    const todo = todoOf(strategy);
    if (todo.length === 0) {
      continue;
    }
    const label = STRATEGY_LABELS[strategy.id];
    const startedAt = now();
    log(`[${label}] ${todo.length} decisions to go.`);
    let done = 0;
    for (const c of todo) {
      if (paused()) {
        log(`[${label}] paused after ${done} decisions; run the same command again to resume.`);
        return { status: "paused", remaining: remainingTotal() };
      }
      await decide(strategy, c);
      done += 1;
      if (done % every === 0 || done === todo.length) {
        const elapsed = now() - startedAt;
        const eta = done === todo.length ? 0 : (elapsed / done) * (todo.length - done);
        log(
          `[${label}] ${done}/${todo.length} (${Math.round((done / todo.length) * 100)}%), ` +
            `${formatDuration(elapsed)} elapsed, about ${formatDuration(eta)} to go; last: ${c.input.chore} ${c.input.date}.`,
        );
      }
    }
  }
  return { status: "complete", remaining: remainingTotal() };
}
