/**
 * `sib backtest`: replays the snapshot with the chosen strategies and writes `report.json` and
 * `report.md` next to the progress files (REQ-018, AC-019.3 harness, NFR-005, NFR-012).
 *
 *   sib backtest [--snapshot <dir>] [--out <dir>] [--strategies rule,fixed,e2b,e4b,e4b-ft]
 *                [--splits all|train|holdout] [--from <date>] [--to <date>] [--pause-at 07:00]
 *                [--habits <file>] [--fake-model] [--estimate-only] [--restart]
 *
 * Open-Meteo is not called: the snapshot is read from disk (`sib snapshot` writes it).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { nextMadridWallTime } from "../../domain/time.js";
import { parseRulesConfig } from "../../domain/rules/index.js";
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
import { readSnapshot, serializeSnapshot } from "../snapshot.js";

import { buildCases } from "./cases.js";
import { backtestFakeModel } from "./fake-model.js";
import { GemmaStrategy, ModelDigestMismatchError, ModelOfflineError } from "./gemma-strategy.js";
import {
  BACKTEST_DRYER,
  BACKTEST_SEED,
  FIXED_ROUTINE_DESCRIPTION,
  SKIP_FROM_BAND,
} from "./policy.js";
import {
  buildReport,
  renderMarkdown,
  serializeReport,
  type MethodInfo,
  type StrategyInfo,
} from "./report.js";
import { runBacktest, type SplitSelection } from "./run.js";
import { FixedRoutineStrategy, RuleStrategy } from "./strategies.js";
import {
  FileDecisionStore,
  readRunFile,
  writeRunFile,
  describeMismatch,
  FingerprintMismatchError,
  type RunFile,
  type RunFingerprint,
} from "./store.js";
import { STRATEGY_IDS, STRATEGY_LABELS, caseKey, type Strategy, type StrategyId } from "./types.js";

export const BACKTEST_USAGE =
  "Usage: sib backtest [--snapshot <dir>] [--out <dir>] [--strategies rule,fixed,e2b,e4b,e4b-ft] " +
  "[--splits all|train|holdout] [--from <date>] [--to <date>] [--pause-at HH:MM] " +
  "[--habits <file>] [--fake-model] [--estimate-only] [--restart]";

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
  readonly progressEvery?: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fingerprintOf(inputs: Readonly<Record<string, unknown>>): RunFingerprint {
  return { hash: sha256(JSON.stringify(inputs)), inputs };
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

const habitsSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));

function readHabits(path: string | undefined): Record<string, string | boolean> {
  if (path === undefined) {
    return {};
  }
  return habitsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function findSnapshotDirectory(given: string | undefined, cwd: string): string {
  if (given !== undefined) {
    return resolve(cwd, given);
  }
  const root = join(cwd, "data-snapshots");
  const found = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && existsSync(join(root, entry.name, "snapshot.json")),
        )
        .map((entry) => join(root, entry.name))
    : [];
  if (found.length !== 1) {
    throw new UsageError(
      found.length === 0
        ? "No snapshot found in data-snapshots/. Run `sib snapshot` first or pass --snapshot <dir>."
        : `Several snapshots in data-snapshots/ (${found.map((dir) => basename(dir)).join(", ")}); pass --snapshot <dir>.`,
    );
  }
  return found[0] ?? "";
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
    keepAlive: config.ollama.keepAlive,
    temperature: config.ollama.temperature,
    seed: BACKTEST_SEED,
  });
  const health = await client.warmUp();
  if (health.state === "offline") {
    throw new ModelOfflineError(
      `${STRATEGY_LABELS[id]} (${entry.tag}) is not usable: ${health.detail ?? "no answer"}. Start Ollama and pull the model, then run the same command again.`,
    );
  }
  return { client, tag: entry.tag, pinnedDigest: entry.digest };
}

/** Runs `sib backtest`; returns the process exit code. */
export async function backtestCommand(
  args: readonly string[],
  log: (line: string) => void,
  deps: BacktestDeps = {},
): Promise<number> {
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
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
      },
      allowPositionals: false,
    }));
  } catch (error) {
    log(`${(error as Error).message}\n${BACKTEST_USAGE}`);
    return 1;
  }

  let closeAll: () => void = () => undefined;
  try {
    const ids = parseStrategies(values.strategies);
    const splits = parseSplits(values.splits);
    const from = parseDate("--from", values.from);
    const to = parseDate("--to", values.to);
    const pauseAtMs = parsePauseAt(values["pause-at"], now());
    const habits = readHabits(values.habits);
    const fake = values["fake-model"] === true || env["SIB_FAKE_MODEL"] === "1";

    const configDir = deps.configDir ?? CONFIG_DIR;
    const rulesText = readFileSync(join(configDir, "rules.json"), "utf8");
    const rules = parseRulesConfig(JSON.parse(rulesText) as unknown);
    const catalogue = loadSavings(join(configDir, "savings.json"));
    const models = loadModelsConfig(join(configDir, "models.json"));

    const snapshotDirectory = findSnapshotDirectory(values.snapshot, cwd);
    const snapshot = await readSnapshot(snapshotDirectory);
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
      habits,
      savings: catalogue,
    } satisfies MethodInfo;

    const fingerprint = fingerprintOf({
      schema: 1,
      snapshot: sha256(serializeSnapshot(snapshot)),
      rules: method.rulesSha256,
      savings: sha256(JSON.stringify(catalogue)),
      prompt: method.bookmakerPrompt,
      model: method.model,
      habits,
      skipFromBand: SKIP_FROM_BAND,
      dryer: BACKTEST_DRYER,
      routine: FIXED_ROUTINE_DESCRIPTION,
      fakeModel: fake,
    });

    if (values.restart === true) {
      rmSync(outDirectory, { recursive: true, force: true });
    }
    mkdirSync(outDirectory, { recursive: true });
    const saved = readRunFile(outDirectory);
    if (saved !== undefined && saved.fingerprint.hash !== fingerprint.hash) {
      throw new FingerprintMismatchError(
        `${outDirectory} holds a run with a different ${describeMismatch(saved.fingerprint, fingerprint)}. ` +
          "Use another --out, or --restart to discard that run.",
      );
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

    const strategies: Strategy[] = [];
    const infos: StrategyInfo[] = [];
    const gemmaStrategies: GemmaStrategy[] = [];
    const modelTags: Record<string, { tag: string; digest: string | null }> = {
      ...(saved?.models ?? {}),
    };
    closeAll = () => {
      for (const strategy of gemmaStrategies) {
        strategy.close();
      }
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

    const startedAt = saved?.startedAt ?? new Date(now()).toISOString();
    const persist = (): RunFile => {
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
      const run: RunFile = { schemaVersion: 1, fingerprint, startedAt, models: modelTags };
      writeRunFile(outDirectory, run);
      return run;
    };
    persist();

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
        ...(pauseAtMs === undefined ? {} : { pauseAtMs }),
        ...(values["estimate-only"] === true ? { estimateOnly: true } : {}),
        ...(deps.progressEvery === undefined ? {} : { progressEvery: deps.progressEvery }),
      });
    } catch (error) {
      failure = error;
    }
    const run = persist();

    // The report always reflects what is on disk, complete or not.
    const wantedKeys = new Set(wanted.map((c) => c.key));
    const records = store
      .records()
      .filter(
        (record) =>
          ids.includes(record.strategy) && wantedKeys.has(caseKey(record.chore, record.date)),
      );
    const complete = outcome?.status === "complete";
    const report = buildReport({
      complete,
      fakeModel: fake,
      snapshot,
      cases: wanted,
      skipped: built.skipped,
      records,
      strategies: infos.map((info) => {
        const model = run.models[info.id];
        return model === undefined
          ? info
          : { ...info, ...(model.digest === null ? {} : { modelDigest: model.digest }) };
      }),
      method,
      splits,
    });
    if (outcome?.status !== "estimate_only") {
      writeFileSync(join(outDirectory, "report.json"), serializeReport(report));
      writeFileSync(join(outDirectory, "report.md"), renderMarkdown(report));
      log(
        `Report (${complete ? "complete" : "partial"}): ${join(outDirectory, "report.md")} and report.json.`,
      );
    }

    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error("the backtest failed", { cause: failure });
    }
    if (outcome?.status === "paused") {
      log(`Paused with ${outcome.remaining} decisions to go. Run the same command to resume.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ModelOfflineError) {
      log(
        `Gemma is not reachable: ${error.message}\nProgress is saved; run the same command to resume.`,
      );
      return 2;
    }
    if (error instanceof ModelDigestMismatchError) {
      log(`${error.message}\nThe model changed under the run. Use another --out or --restart.`);
      return 2;
    }
    if (error instanceof UsageError || error instanceof FingerprintMismatchError) {
      log(`${error.message}\n${error instanceof UsageError ? BACKTEST_USAGE : ""}`.trimEnd());
      return 1;
    }
    throw error;
  } finally {
    closeAll();
  }
}
