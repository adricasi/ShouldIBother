/**
 * The run loop: strategy by strategy (so Ollama loads each model once), day by day, with every
 * finished decision appended to the store before the next one starts. Resumable (finished
 * decisions are skipped), paused at a clock time between decisions, with progress lines and the
 * per-model estimate printed before the long part starts (NFR-005).
 *
 * Unattended robustness: an outage waits for the model (bounded), and a call that times out is
 * not recorded but left undecided and tried again, up to `MAX_ATTEMPTS` tries over all resumes.
 */

import { assertNoLookahead } from "./cases.js";
import { BACKTEST_BUDGET_MS, estimateModel, formatDuration, renderEstimate } from "./estimate.js";
import { ModelOfflineError, ModelStalledError } from "./gemma-strategy.js";
import type { DecisionStore } from "./store.js";
import {
  STRATEGY_LABELS,
  recordKey,
  type BacktestCase,
  type DecisionRecord,
  type Strategy,
} from "./types.js";

export type SplitSelection = "all" | "train" | "holdout";

/** A day whose Gemma call timed out is tried at most this often, over all resumes. */
export const MAX_ATTEMPTS = 3;
/** How long the run waits for a model that is unreachable before it stops (exit code 2). */
export const OFFLINE_WAIT_MS = 10 * 60_000;
/** Times the run recovers from an outage on one day before it gives up on the model. */
const MAX_RECOVERIES_PER_DAY = 3;

/** Tries per decision that ended without an answer in time; the command persists them. */
export interface AttemptLog {
  /** Records one more failed try and returns how many there are now. */
  bump(key: string): number;
}

export interface RunOptions {
  readonly cases: readonly BacktestCase[];
  readonly strategies: readonly Strategy[];
  readonly store: DecisionStore;
  readonly splits?: SplitSelection;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /** Waits; replaced in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Stop between decisions once this instant has passed (`--pause-at`). */
  readonly pauseAtMs?: number;
  /** Decisions measured per Gemma model before the estimate is printed. */
  readonly probe?: number;
  /** Print the estimate and stop. */
  readonly estimateOnly?: boolean;
  /** A progress line every this many decisions of a strategy (and at its start and end). */
  readonly progressEvery?: number;
  readonly budgetMs?: number;
  readonly attempts?: AttemptLog;
  readonly offlineWaitMs?: number;
}

/** `incomplete`: some days got no answer in time and wait for a resume. */
export type RunStatus = "complete" | "paused" | "estimate_only" | "incomplete";

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
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const wanted = selected(options.cases, options.splits ?? "all");
  const probeTarget = options.probe ?? DEFAULT_PROBE;
  const every = Math.max(1, options.progressEvery ?? DEFAULT_PROGRESS_EVERY);
  const attempts: AttemptLog = options.attempts ?? new MemoryAttempts();

  const todoOf = (strategy: Strategy): BacktestCase[] =>
    wanted.filter((c) => !store.has(recordKey(strategy.id, c.input.chore, c.input.date)));
  const remainingTotal = (): number =>
    options.strategies.reduce((sum, strategy) => sum + todoOf(strategy).length, 0);
  const paused = (): boolean => options.pauseAtMs !== undefined && now() >= options.pauseAtMs;

  /** Waits for the model with a growing pause (5 s, 10 s, ... 60 s), up to the bound. */
  const waitForModel = async (strategy: Strategy): Promise<boolean> => {
    const bound = options.offlineWaitMs ?? OFFLINE_WAIT_MS;
    let waited = 0;
    let pause = 5000;
    while (waited < bound) {
      const step = Math.min(pause, bound - waited);
      log(
        `[${STRATEGY_LABELS[strategy.id]}] Gemma is not reachable; checking again in ${formatDuration(step)} (${formatDuration(waited)} of ${formatDuration(bound)} waited).`,
      );
      await sleep(step);
      waited += step;
      pause = Math.min(pause * 2, 60_000);
      if ((await strategy.reachable?.()) === true) {
        log(`[${STRATEGY_LABELS[strategy.id]}] Gemma is back.`);
        return true;
      }
    }
    return false;
  };

  /** Makes and stores one decision. Returns false when the day is left undecided. */
  const decide = async (strategy: Strategy, c: BacktestCase): Promise<boolean> => {
    // The guard runs on every decision, whatever the strategy: a forecast value from a model run
    // that started at or after the decision time stops the run (AC-018.1).
    assertNoLookahead(c.input);
    const key = recordKey(strategy.id, c.input.chore, c.input.date);
    for (let recoveries = 0; ; recoveries += 1) {
      try {
        store.append(toRecord(strategy, c, await strategy.decide(c.input)));
        return true;
      } catch (error) {
        if (error instanceof ModelStalledError) {
          const tries = attempts.bump(key);
          if (tries >= MAX_ATTEMPTS) {
            log(
              `[${STRATEGY_LABELS[strategy.id]}] ${c.input.chore} ${c.input.date}: no answer in time ${tries} times; the rule odds stand, as in the live app.`,
            );
            store.append(toRecord(strategy, c, error.decision));
            return true;
          }
          log(
            `[${STRATEGY_LABELS[strategy.id]}] ${c.input.chore} ${c.input.date}: no answer in time (try ${tries} of ${MAX_ATTEMPTS}); left undecided, it is tried again.`,
          );
          return false;
        }
        if (
          error instanceof ModelOfflineError &&
          strategy.reachable !== undefined &&
          recoveries < MAX_RECOVERIES_PER_DAY &&
          (await waitForModel(strategy))
        ) {
          continue;
        }
        throw error;
      }
    }
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
  const releaseAll = async (): Promise<void> => {
    for (const strategy of gemma) {
      await strategy.release?.();
    }
  };

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
    // Only the first few days are tried for the measurement: a stuck day must not hold it up.
    for (const c of todoOf(strategy).slice(0, probeTarget)) {
      if (paused()) {
        log(
          `[${STRATEGY_LABELS[strategy.id]}] paused while measuring; run the same command again to resume.`,
        );
        await releaseAll();
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
        // A day with a safety alert runs no Gemma job.
        todoOf(strategy).filter((c) => c.input.alert === null).length,
      ),
    ),
    options.budgetMs ?? BACKTEST_BUDGET_MS,
  )) {
    log(line);
  }
  if (options.estimateOnly === true) {
    await releaseAll();
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
    let stalled: BacktestCase[] = [];
    // First pass over every day, then one more over the days that got no answer in time.
    for (const pass of [todo, null]) {
      const queue = pass ?? stalled;
      if (pass === null) {
        if (queue.length === 0) {
          break;
        }
        log(`[${label}] trying the ${queue.length} days again that got no answer in time.`);
        stalled = [];
      }
      for (const c of queue) {
        if (paused()) {
          log(`[${label}] paused after ${done} decisions; run the same command again to resume.`);
          await releaseAll();
          return { status: "paused", remaining: remainingTotal() };
        }
        if (await decide(strategy, c)) {
          done += 1;
        } else {
          stalled.push(c);
        }
        if (pass !== null && (done % every === 0 || done === todo.length)) {
          const elapsed = now() - startedAt;
          const eta = done === todo.length ? 0 : (elapsed / done) * (todo.length - done);
          log(
            `[${label}] ${done}/${todo.length} (${Math.round((done / todo.length) * 100)}%), ` +
              `${formatDuration(elapsed)} elapsed, about ${formatDuration(eta)} to go; last: ${c.input.chore} ${c.input.date}.`,
          );
        }
      }
    }
    await strategy.release?.();
  }
  const remaining = remainingTotal();
  return { status: remaining === 0 ? "complete" : "incomplete", remaining };
}

/** Attempts kept in memory only (tests, and runs without a run directory). */
export class MemoryAttempts implements AttemptLog {
  private readonly counts = new Map<string, number>();

  bump(key: string): number {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}
