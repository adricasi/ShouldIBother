/**
 * `sib backtest`: replays the snapshot with the chosen strategies and writes a report (Markdown
 * and JSON) next to the progress files (REQ-018, AC-019.3 harness, NFR-005, NFR-012).
 *
 *   sib backtest [--snapshot <dir>] [--out <dir>] [--strategies rule,fixed,e2b,e4b,e4b-ft]
 *                [--splits all|train|holdout] [--from <date>] [--to <date>] [--pause-at 07:00]
 *                [--habits <file>] [--fake-model] [--estimate-only] [--restart] [--help]
 *
 * Open-Meteo is not called: the snapshot is read from disk (`sib snapshot` writes it). Without
 * `--habits` the bookmaker sees the fixed synthetic habit profile (`training/habits.synthetic.json`),
 * the same one the fine-tune dataset uses, so the base and fine-tuned models are compared on one prompt.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parseRulesConfig } from "../../domain/rules/index.js";
import { nextMadridWallTime } from "../../domain/time.js";
import { CONFIG_DIR } from "../../server/config.js";
import { BOOKMAKER_PROMPT } from "../../server/gemma/bookmaker.js";
import {
  JOB_DEADLINE_MS,
  MAX_MODEL_CALLS,
  MODEL_CALL_TIMEOUT_MS,
} from "../../server/gemma/runner.js";
import type { ModelClient } from "../../server/model/client.js";
import { loadModelsConfig, type ModelsConfig } from "../../server/model/config.js";
import { OllamaClient } from "../../server/model/ollama.js";
import { loadSavings } from "../../server/savings.js";
import {
  habitsDigest,
  loadSyntheticHabits,
  looksLikeHouseholdData,
  readHabitsFile,
  type Habits,
} from "../habits.js";
import { SnapshotLocationError, findSnapshotDirectory } from "../snapshot-location.js";
import { readSnapshot, serializeSnapshot } from "../snapshot.js";

import { buildCases } from "./cases.js";
import { backtestFakeModel } from "./fake-model.js";
import { GemmaStrategy, ModelDigestMismatchError, ModelOfflineError } from "./gemma-strategy.js";
import {
  BACKTEST_DRYER,
  BACKTEST_KEEP_ALIVE,
  BACKTEST_SEED,
  FIXED_ROUTINE_DESCRIPTION,
  SKIP_FROM_BAND,
} from "./policy.js";
import {
  buildPerformance,
  buildReport,
  renderMarkdown,
  serializeReport,
  type MethodInfo,
  type StrategyInfo,
} from "./report.js";
import { runBacktest, type AttemptLog, type SplitSelection } from "./run.js";
import { FixedRoutineStrategy, RuleStrategy } from "./strategies.js";
import {
  FileDecisionStore,
  FingerprintMismatchError,
  PERFORMANCE_FILE,
  RunDirectoryError,
  acquireLock,
  clearRunDirectory,
  describeMismatch,
  inspectRunDirectory,
  writeFileAtomic,
  writeRunFile,
  type RunFile,
  type RunFingerprint,
} from "./store.js";
import { STRATEGY_IDS, STRATEGY_LABELS, caseKey, type Strategy, type StrategyId } from "./types.js";

export const BACKTEST_USAGE =
  "Usage: sib backtest [--snapshot <dir>] [--out <dir>] [--strategies rule,fixed,e2b,e4b,e4b-ft] " +
  "[--splits all|train|holdout] [--from <date>] [--to <date>] [--pause-at HH:MM] " +
  "[--habits <file>] [--fake-model] [--estimate-only] [--restart] [--help]";

/** What the process exits with: a script (or the Friday-night wrapper) can tell the cases apart. */
export const EXIT = {
  complete: 0,
  usage: 1,
  modelUnreachable: 2,
  paused: 3,
  incomplete: 4,
} as const;

export const BACKTEST_HELP = [
  BACKTEST_USAGE,
  "",
  "Exit codes:",
  "  0  finished (or --estimate-only)       3  paused by --pause-at; run the same command to resume",
  "  1  bad option, config, snapshot or run directory",
  "  2  Gemma unreachable (waited up to 10 min) or the model changed; progress is saved",
  "  4  finished its pass but some days got no answer in time; run the same command to retry them",
  "",
  "Reports are named report-<strategies>-<splits>.md/.json, so a smaller run never overwrites a",
  "fuller one; performance.json holds the measured model time (the reports do not change on a re-run).",
].join("\n");

/** The strategies of a default run: the post's comparison, without the fine-tuned model (T-014). */
const DEFAULT_STRATEGIES: readonly StrategyId[] = ["rule", "fixed", "e4b", "e2b"];

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface BacktestDeps {
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly configDir?: string;
  /** Replaces the model factory (tests); the default is Ollama, or the fake with `--fake-model`. */
  readonly createModel?: (id: StrategyId) => Promise<ModelClient>;
  /** Where `data-snapshots/` and the default output live. */
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly progressEvery?: number;
  /** The `fetch` of the Ollama client (tests). */
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for an unreachable model (default 10 min). */
  readonly offlineWaitMs?: number;
}

/** The base name of a run's reports: strategies and splits, so runs never overwrite each other. */
export function reportBaseName(
  ids: readonly StrategyId[],
  splits: SplitSelection,
  from?: string,
  to?: string,
): string {
  return `report-${ids.join("-")}-${splits}${from === undefined ? "" : `-from-${from}`}${to === undefined ? "" : `-to-${to}`}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fingerprintOf(inputs: Readonly<Record<string, unknown>>): RunFingerprint {
  return { hash: sha256(JSON.stringify(inputs)), inputs };
}

/** Turns any failure while reading an input into a one-line usage error. */
function reading<T>(what: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof UsageError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "unreadable";
    throw new UsageError(`Cannot read ${what}: ${message.split("\n")[0] ?? message}`);
  }
}

function parseStrategies(text: string | undefined): StrategyId[] {
  if (text === undefined) {
    return [...DEFAULT_STRATEGIES];
  }
  const ids = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const unknown = ids.filter((id) => !(STRATEGY_IDS as readonly string[]).includes(id));
  if (ids.length === 0 || unknown.length > 0) {
    throw new UsageError(
      `Unknown strategy ${unknown.join(", ") || "(none given)"}; choose from ${STRATEGY_IDS.join(", ")}.`,
    );
  }
  // Fixed order, no duplicates: the run does not depend on how the list was typed.
  return STRATEGY_IDS.filter((id) => ids.includes(id));
}

function parseSplits(text: string | undefined): SplitSelection {
  if (text === undefined || text === "all" || text === "train" || text === "holdout") {
    return text ?? "all";
  }
  throw new UsageError(`--splits must be all, train or holdout, got "${text}".`);
}

function parseDate(name: string, text: string | undefined): string | undefined {
  if (text !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new UsageError(`${name} must be a date like 2026-09-01, got "${text}".`);
  }
  return text;
}

function parsePauseAt(text: string | undefined, nowMs: number): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (match === null) {
    throw new UsageError(`--pause-at must be a time like 07:00, got "${text}".`);
  }
  return nextMadridWallTime(nowMs, Number(match[1]), Number(match[2]));
}

function readHabits(path: string | undefined): Habits {
  return path === undefined ? loadSyntheticHabits() : readHabitsFile(path);
}

/** A warning when the habits file looks like household data, which must not enter a backtest. */
function habitsWarning(path: string, home: string, env: BacktestDeps["env"]): string | undefined {
  return looksLikeHouseholdData(path, { home, env: env ?? {} })
    ? `WARNING: ${path} looks like household data. The backtest must use a synthetic profile only (AC-018.4, AC-019.6); household data must not leave the laptop.`
    : undefined;
}

async function createModel(
  id: StrategyId,
  config: ModelsConfig,
  fake: boolean,
  deps: BacktestDeps,
): Promise<{ client: ModelClient; tag: string; pinnedDigest: string | undefined }> {
  if (deps.createModel !== undefined) {
    return { client: await deps.createModel(id), tag: `test:${id}`, pinnedDigest: undefined };
  }
  if (fake) {
    return { client: backtestFakeModel(id), tag: "fake", pinnedDigest: undefined };
  }
  const entry = config.models[id];
  if (entry === undefined) {
    throw new UsageError(
      `config/models.json has no models.${id}.tag. Set it to the Ollama tag of ${STRATEGY_LABELS[id]}, ` +
        "or pass --fake-model to test the pipeline on recorded fixtures.",
    );
  }
  const client = new OllamaClient({
    baseUrl: config.ollama.baseUrl,
    model: entry.tag,
    // Short, not the live app's 24 h: the GPU is free again soon after the run stops or pauses.
    keepAlive: BACKTEST_KEEP_ALIVE,
    temperature: config.ollama.temperature,
    seed: BACKTEST_SEED,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  const health = await client.warmUp();
  if (health.state === "offline") {
    throw new ModelOfflineError(
      `${STRATEGY_LABELS[id]} (${entry.tag}) is not usable: ${health.detail ?? "no answer"}. Start Ollama and pull the model, then run the same command again.`,
    );
  }
  return { client, tag: entry.tag, pinnedDigest: entry.digest };
}

/** Runs `sib backtest`; returns the process exit code (see `EXIT`). */
export async function backtestCommand(
  args: readonly string[],
  log: (line: string) => void,
  deps: BacktestDeps = {},
): Promise<number> {
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        snapshot: { type: "string" },
        out: { type: "string" },
        strategies: { type: "string" },
        splits: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        "pause-at": { type: "string" },
        habits: { type: "string" },
        "fake-model": { type: "boolean" },
        "estimate-only": { type: "boolean" },
        restart: { type: "boolean" },
        help: { type: "boolean" },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    log(`${(error as Error).message}\n${BACKTEST_USAGE}`);
    return EXIT.usage;
  }
  if (values.help === true) {
    log(BACKTEST_HELP);
    return EXIT.complete;
  }

  let releaseLock: () => void = () => undefined;
  const gemmaStrategies: GemmaStrategy[] = [];
  try {
    const ids = parseStrategies(values.strategies);
    const splits = parseSplits(values.splits);
    const from = parseDate("--from", values.from);
    const to = parseDate("--to", values.to);
    const pauseAtMs = parsePauseAt(values["pause-at"], now());
    const habitsPath = values.habits === undefined ? undefined : resolve(cwd, values.habits);
    if (habitsPath !== undefined) {
      const warning = habitsWarning(habitsPath, home, env);
      if (warning !== undefined) {
        log(warning);
      }
    }
    const habits = reading(
      `the habits file ${values.habits ?? "training/habits.synthetic.json"}`,
      () => readHabits(habitsPath),
    );
    const fake = values["fake-model"] === true || env["SIB_FAKE_MODEL"] === "1";
    if (fake && ids.some((id) => id !== "rule" && id !== "fixed")) {
      log(
        `${values["fake-model"] === true ? "--fake-model" : "SIB_FAKE_MODEL=1"}: the Gemma strategies run on recorded fixtures, not on Gemma; the numbers test the pipeline only.`,
      );
    }

    const configDir = deps.configDir ?? CONFIG_DIR;
    const rulesText = reading("config/rules.json", () =>
      readFileSync(join(configDir, "rules.json"), "utf8"),
    );
    const rules = reading("config/rules.json", () =>
      parseRulesConfig(JSON.parse(rulesText) as unknown),
    );
    const catalogue = reading("config/savings.json", () =>
      loadSavings(join(configDir, "savings.json")),
    );
    const models = reading("config/models.json", () =>
      loadModelsConfig(join(configDir, "models.json")),
    );

    let snapshotDirectory: string;
    try {
      snapshotDirectory = findSnapshotDirectory(values.snapshot, { cwd, home, env });
    } catch (error) {
      if (error instanceof SnapshotLocationError) {
        throw new UsageError(error.message);
      }
      throw error;
    }
    let snapshot;
    try {
      snapshot = await readSnapshot(snapshotDirectory);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unreadable";
      throw new UsageError(
        `Cannot read the snapshot in ${snapshotDirectory}: ${message.split("\n")[0] ?? message}`,
      );
    }
    const outDirectory = resolve(
      cwd,
      values.out ?? join("backtest-runs", basename(snapshotDirectory)),
    );

    const method = {
      rulesSha256: sha256(rulesText),
      rules,
      bookmakerPrompt: { version: BOOKMAKER_PROMPT.version, sha256: sha256(BOOKMAKER_PROMPT.text) },
      model: {
        temperature: models.ollama.temperature,
        seed: BACKTEST_SEED,
        toolUse: models.gemma.toolUse,
        answerMode: models.gemma.answerMode,
        callTimeoutMs: MODEL_CALL_TIMEOUT_MS,
        deadlineMs: JOB_DEADLINE_MS,
        maxModelCalls: MAX_MODEL_CALLS,
      },
      // The values stay on the laptop and out of every file: only a hash is kept.
      habits: { entries: Object.keys(habits).length, sha256: habitsDigest(habits) },
      savings: catalogue,
    } satisfies MethodInfo;

    const fingerprint = fingerprintOf({
      schema: 1,
      snapshot: sha256(serializeSnapshot(snapshot)),
      rules: method.rulesSha256,
      savings: sha256(JSON.stringify(catalogue)),
      prompt: method.bookmakerPrompt,
      model: method.model,
      // The default is the synthetic profile (T-031); before that it was none ({}). A run made
      // with the old default has another hash here, so it refuses to resume: `--habits <file
      // containing {}>` reproduces the old behaviour, `--restart` starts over.
      habits: method.habits.sha256,
      skipFromBand: SKIP_FROM_BAND,
      dryer: BACKTEST_DRYER,
      routine: FIXED_ROUTINE_DESCRIPTION,
      fakeModel: fake,
    });

    // One process at a time per directory; then see what the directory holds.
    releaseLock = acquireLock(outDirectory);
    const restart = values.restart === true;
    const state = inspectRunDirectory(outDirectory);
    const saved: RunFile | undefined = restart ? undefined : state.saved;
    if (restart) {
      if (state.foreign.length > 0) {
        throw new RunDirectoryError(
          `${outDirectory} holds files that sib backtest did not write (${state.foreign.slice(0, 3).join(", ")}); nothing was deleted. Use an empty or dedicated --out.`,
        );
      }
    } else if (saved === undefined && state.hasDecisions) {
      throw new RunDirectoryError(
        `${outDirectory} has decisions.jsonl but no run.json, so it can not be resumed safely. Use --restart to start over or another --out.`,
      );
    } else if (saved === undefined && state.foreign.length > 0) {
      throw new RunDirectoryError(
        `${outDirectory} holds files that sib backtest did not write (${state.foreign.slice(0, 3).join(", ")}). Use an empty or dedicated --out.`,
      );
    } else if (saved !== undefined && saved.fingerprint.hash !== fingerprint.hash) {
      throw new FingerprintMismatchError(
        `${outDirectory} holds a run with a different ${describeMismatch(saved.fingerprint, fingerprint)}. ` +
          "Use another --out, or --restart to discard that run.",
      );
    }

    // The models come first: only when they answer is anything deleted or written.
    const strategies: Strategy[] = [];
    const infos: StrategyInfo[] = [];
    const modelTags: Record<string, { tag: string; digest: string | null }> = {
      ...(saved?.models ?? {}),
    };
    for (const id of ids) {
      if (id === "rule") {
        strategies.push(new RuleStrategy());
        infos.push({ id });
      } else if (id === "fixed") {
        strategies.push(new FixedRoutineStrategy());
        infos.push({ id });
      } else {
        const created = await createModel(id, models, fake, deps);
        const savedModel = saved?.models[id];
        if (savedModel !== undefined && savedModel.tag !== created.tag) {
          throw new FingerprintMismatchError(
            `${STRATEGY_LABELS[id]} ran as ${savedModel.tag} in this run directory, now ${created.tag}. Use another --out or --restart.`,
          );
        }
        const expectedDigest = created.pinnedDigest ?? savedModel?.digest ?? undefined;
        const strategy = new GemmaStrategy({
          id,
          model: created.client,
          rules,
          toolUse: models.gemma.toolUse,
          answerMode: models.gemma.answerMode,
          habits,
          ...(expectedDigest === undefined ? {} : { expectedDigest }),
        });
        gemmaStrategies.push(strategy);
        strategies.push(strategy);
        modelTags[id] = { tag: created.tag, digest: savedModel?.digest ?? null };
        infos.push({ id, modelTag: created.tag });
      }
    }

    if (restart) {
      clearRunDirectory(outDirectory);
    }
    const store = FileDecisionStore.open(outDirectory);
    if (saved !== undefined) {
      log(`Resuming ${outDirectory}: ${store.records().length} decisions already made.`);
    }

    const built = buildCases(snapshot, rules, {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
    const wanted = built.cases.filter((c) => splits === "all" || c.split === splits);
    log(
      `Snapshot ${snapshot.location.name} ${snapshot.startDate} to ${snapshot.endDate}: ${built.cases.length} chore-days to simulate` +
        `${built.skipped.length > 0 ? `, ${built.skipped.length} not simulated` : ""}.`,
    );

    const run: RunFile = {
      schemaVersion: 1,
      fingerprint,
      startedAt: saved?.startedAt ?? new Date(now()).toISOString(),
      models: modelTags,
      attempts: { ...(saved?.attempts ?? {}) },
    };
    const persist = (): void => {
      for (const id of ids) {
        const digest = store
          .records()
          .find((record) => record.strategy === id && record.gemma?.modelDigest != null)
          ?.gemma?.modelDigest;
        const entry = modelTags[id];
        if (entry !== undefined && digest !== undefined && digest !== null) {
          modelTags[id] = { tag: entry.tag, digest };
        }
      }
      writeRunFile(outDirectory, run);
    };
    persist();
    const attempts: AttemptLog = {
      bump(key) {
        run.attempts[key] = (run.attempts[key] ?? 0) + 1;
        persist();
        return run.attempts[key] ?? 1;
      },
    };

    let outcome;
    let failure: unknown;
    try {
      outcome = await runBacktest({
        cases: built.cases,
        strategies,
        store,
        splits,
        log,
        now,
        attempts,
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.offlineWaitMs === undefined ? {} : { offlineWaitMs: deps.offlineWaitMs }),
        ...(pauseAtMs === undefined ? {} : { pauseAtMs }),
        ...(values["estimate-only"] === true ? { estimateOnly: true } : {}),
        ...(deps.progressEvery === undefined ? {} : { progressEvery: deps.progressEvery }),
      });
    } catch (error) {
      failure = error;
    }
    persist();

    // The report always reflects what is on disk, complete or not. Its name carries the
    // strategies and splits, so a smaller run never overwrites a fuller one.
    const wantedKeys = new Set(wanted.map((c) => c.key));
    const records = store
      .records()
      .filter(
        (record) =>
          ids.includes(record.strategy) && wantedKeys.has(caseKey(record.chore, record.date)),
      );
    const complete = outcome?.status === "complete";
    const reportInfos = infos.map((info) => {
      const model = run.models[info.id];
      return model === undefined || model.digest === null
        ? info
        : { ...info, modelDigest: model.digest };
    });
    if (outcome?.status !== "estimate_only") {
      const report = buildReport({
        complete,
        fakeModel: fake,
        snapshot,
        cases: wanted,
        skipped: built.skipped,
        records,
        strategies: reportInfos,
        method,
        splits,
      });
      const base = join(outDirectory, reportBaseName(ids, splits, from, to));
      writeFileAtomic(`${base}.json`, serializeReport(report));
      writeFileAtomic(`${base}.md`, renderMarkdown(report));
      const performance = buildPerformance(records, reportInfos);
      writeFileAtomic(
        join(outDirectory, PERFORMANCE_FILE),
        `${JSON.stringify(performance, null, 2)}\n`,
      );
      log(`Report (${complete ? "complete" : "partial"}): ${base}.md and .json.`);
      for (const [id, latency] of Object.entries(performance)) {
        log(
          `Model time ${STRATEGY_LABELS[id as StrategyId]}: ${latency.jobs} jobs, ${latency.calls} calls, ${(latency.meanCallMs / 1000).toFixed(1)} s per call (${PERFORMANCE_FILE}).`,
        );
      }
    }

    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error("the backtest failed", { cause: failure });
    }
    if (outcome?.status === "paused") {
      log(`Paused with ${outcome.remaining} decisions to go. Run the same command to resume.`);
      return EXIT.paused;
    }
    if (outcome?.status === "incomplete") {
      log(
        `${outcome.remaining} decisions got no answer in time and are left undecided. Run the same command to try them again.`,
      );
      return EXIT.incomplete;
    }
    return EXIT.complete;
  } catch (error) {
    if (error instanceof ModelOfflineError) {
      log(
        `Gemma is not reachable: ${error.message}\nProgress is saved; run the same command to resume.`,
      );
      return EXIT.modelUnreachable;
    }
    if (error instanceof ModelDigestMismatchError) {
      log(`${error.message}\nThe model changed under the run. Use another --out or --restart.`);
      return EXIT.modelUnreachable;
    }
    if (
      error instanceof UsageError ||
      error instanceof FingerprintMismatchError ||
      error instanceof RunDirectoryError
    ) {
      log(`${error.message}${error instanceof UsageError ? `\n${BACKTEST_USAGE}` : ""}`);
      return EXIT.usage;
    }
    throw error;
  } finally {
    // Give the GPU back whatever happened (a pause, an outage, an error), then free the lock.
    for (const strategy of gemmaStrategies) {
      await strategy.release();
      strategy.close();
    }
    releaseLock();
  }
}
