import type { RulesConfig } from "../domain/rules/index.js";
import { migrate, openDatabase } from "../server/db.js";
import { JobRunner, type RunnerOptions } from "../server/gemma/runner.js";
import { MIGRATIONS } from "../server/migrations/index.js";
import type { ModelClient } from "../server/model/client.js";
import type { ProcessedPhoto } from "../server/photos/process.js";

import { CallLog } from "./call-log.js";
import type { PreparedCase } from "./jobs.js";
import type { CaseRun } from "./types.js";

/** Gemma stopped answering in the middle of the run: the numbers would only measure the outage. */
export class ModelUnreachableError extends Error {
  override readonly name = "ModelUnreachableError";
  constructor(
    readonly caseId: string,
    detail: string,
  ) {
    super(`Gemma stopped answering at case ${caseId}: ${detail}`);
  }
}

export interface RunEvalOptions {
  readonly cases: readonly PreparedCase[];
  readonly model: ModelClient;
  /** The same runner settings the live app uses: tool use mode, answer mode, limits. */
  readonly runner: Pick<RunnerOptions, "toolUse" | "answerMode" | "callTimeoutMs" | "deadlineMs">;
  readonly rules: RulesConfig;
  /** Staged photos by file name, already through the app's photo pipeline. */
  readonly photos: ReadonlyMap<string, ProcessedPhoto>;
  /** Called as each case finishes, for progress output. */
  readonly onCase?: (run: CaseRun, index: number) => void;
}

/**
 * Runs the cases one after another through the real job functions and a real `JobRunner`, as the
 * live app does: queue, deadline, retry, tool enforcement. The decision log goes to a throwaway
 * in-memory database, never to the household's.
 */
export async function runEval(options: RunEvalOptions): Promise<CaseRun[]> {
  const db = openDatabase(":memory:");
  try {
    migrate(db, MIGRATIONS);
    // The eval has no cards or photos; its decision rows carry made-up numbers.
    db.pragma("foreign_keys = OFF");
    const log = new CallLog(options.model);
    const runner = new JobRunner({
      model: log,
      db,
      now: Date.now,
      ...stripUndefined(options.runner),
    });
    let cardId = 0;
    const context = {
      runner,
      log,
      db,
      rules: options.rules,
      photo: (name: string) => {
        const photo = options.photos.get(name);
        if (photo === undefined) {
          throw new Error(`Photo ${name} was not loaded`);
        }
        return photo;
      },
      nextCardId: () => (cardId += 1),
    };
    const runs: CaseRun[] = [];
    for (const [index, prepared] of options.cases.entries()) {
      const run = await prepared.run(context);
      const lost = run.record.steps.find((step) => step.failure === "unavailable");
      if (lost !== undefined) {
        throw new ModelUnreachableError(prepared.id, lost.error ?? "unavailable");
      }
      runs.push(run);
      options.onCase?.(run, index);
    }
    return runs;
  } finally {
    db.close();
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
