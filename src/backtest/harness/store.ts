/**
 * Where a run keeps its progress: an append-only `decisions.jsonl` (one finished decision per
 * line, so a killed run loses at most the decision in flight) and a `run.json` with the run's
 * fingerprint. A run resumes only when the fingerprint matches (NFR-005, NFR-012).
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { OUTCOME_CHORES } from "../../domain/outcomes.js";

import { STRATEGY_IDS, recordKey, type DecisionRecord } from "./types.js";

const gemmaFactsSchema = z
  .object({
    model: z.string(),
    modelDigest: z.string().nullable(),
    promptVersion: z.string(),
    toolMode: z.enum(["called", "injected", "missed"]).nullable(),
    firstAnswerWithoutTool: z.boolean().nullable(),
    calls: z.number().int().min(0),
    retries: z.number().int().min(0),
    latencyMs: z.number().min(0),
    failure: z
      .enum([
        "internal",
        "unavailable",
        "timeout",
        "deadline",
        "invalid",
        "tool_missed",
        "tool_error",
        "unsure",
        "unresolved",
      ])
      .nullable(),
    gemmaBand: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .nullable(),
    bandsFromRule: z.number().int().min(0).nullable(),
  })
  .strict();

const band = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const decisionRecordSchema = z
  .object({
    v: z.literal(1),
    strategy: z.enum(STRATEGY_IDS),
    chore: z.enum(OUTCOME_CHORES),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    split: z.enum(["train", "holdout"]),
    action: z.enum(["skip", "do_it"]),
    basis: z.enum(["rule", "gemma", "rule_fallback", "safety_alert", "fixed_routine"]),
    band: band.nullable(),
    ruleBand: band,
    delivered: z.boolean(),
    forecastQuality: z.enum([
      "day1_previous_runs",
      "short_lead_forecast_optimistic",
      "perfect_forecast_upper_bound",
    ]),
    gemma: gemmaFactsSchema.optional(),
  })
  .strict();

/** What a run is: any change to it starts a new run instead of resuming the old one. */
export interface RunFingerprint {
  readonly hash: string;
  /** The readable inputs behind the hash, so a mismatch can say what changed. */
  readonly inputs: Readonly<Record<string, unknown>>;
}

const runFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    fingerprint: z.object({
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      inputs: z.record(z.string(), z.unknown()),
    }),
    startedAt: z.string(),
    /** The model behind each Gemma strategy, to refuse a resume on a changed or re-pulled model. */
    models: z.record(z.string(), z.object({ tag: z.string(), digest: z.string().nullable() })),
    /** Tries per decision key that ended without an answer in time (timeout, deadline). */
    attempts: z.record(z.string(), z.number().int().min(1)).default({}),
  })
  .strict();

export type RunFile = z.infer<typeof runFileSchema>;

export class FingerprintMismatchError extends Error {
  override readonly name = "FingerprintMismatchError";
}

/** The run directory is damaged, foreign or in use; the message says what to do. */
export class RunDirectoryError extends Error {
  override readonly name = "RunDirectoryError";
}

export interface DecisionStore {
  /** Every decision finished so far, in the order they were written. */
  records(): readonly DecisionRecord[];
  has(key: string): boolean;
  append(record: DecisionRecord): void;
}

export class MemoryDecisionStore implements DecisionStore {
  private readonly list: DecisionRecord[] = [];
  private readonly keys = new Set<string>();

  records(): readonly DecisionRecord[] {
    return this.list;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  append(record: DecisionRecord): void {
    this.remember(record);
  }

  protected remember(record: DecisionRecord): void {
    this.list.push(record);
    this.keys.add(recordKey(record.strategy, record.chore, record.date));
  }
}

/**
 * Parses a `decisions.jsonl` text. A last line cut off by a crash (no newline after it) is
 * dropped and reported as `torn`; a damaged line anywhere else is an error, because skipping it
 * would silently change the report.
 */
export function parseDecisionFile(text: string): { records: DecisionRecord[]; torn: boolean } {
  const lines = text.split("\n");
  const lastLine = lines.findLastIndex((line) => line.trim() !== "");
  const endsCleanly = text === "" || text.endsWith("\n");
  const records: DecisionRecord[] = [];
  let torn = false;
  lines.forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (index === lastLine && !endsCleanly) {
        torn = true; // a cut-off write of the last decision: it will be made again
        return;
      }
      throw new RunDirectoryError(
        `decisions.jsonl line ${index + 1} is not JSON; the file is damaged (use --restart to start over)`,
        { cause: error },
      );
    }
    const parsed = decisionRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new RunDirectoryError(
        `decisions.jsonl line ${index + 1} is not a decision: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
    }
    records.push(parsed.data as DecisionRecord);
  });
  return { records, torn };
}

export function parseDecisionLines(text: string): DecisionRecord[] {
  return parseDecisionFile(text).records;
}

export const DECISIONS_FILE = "decisions.jsonl";
export const RUN_FILE = "run.json";
export const LOCK_FILE = "run.lock";
export const PERFORMANCE_FILE = "performance.json";

/** Writes through a temporary file and a rename, so a crash leaves the old or the new file. */
export function writeFileAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

export class FileDecisionStore extends MemoryDecisionStore {
  private constructor(private readonly path: string) {
    super();
  }

  /** Opens (and creates) the run directory; existing decisions are loaded. */
  static open(directory: string): FileDecisionStore {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, DECISIONS_FILE);
    const store = new FileDecisionStore(path);
    if (existsSync(path)) {
      const { records, torn } = parseDecisionFile(readFileSync(path, "utf8"));
      for (const record of records) {
        store.remember(record);
      }
      if (torn) {
        // Only now is the file rewritten, so the next append starts on a clean line.
        writeFileAtomic(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
      }
    }
    return store;
  }

  override append(record: DecisionRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    this.remember(record);
  }
}

/** Reads `run.json`; undefined when there is none, a clear error when it is damaged. */
export function readRunFile(directory: string): RunFile | undefined {
  const path = join(directory, RUN_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new RunDirectoryError(
      `${path} is damaged (not JSON); use --restart to start over or another --out`,
      { cause: error },
    );
  }
  const parsed = runFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new RunDirectoryError(
      `${path} is damaged (${parsed.error.issues[0]?.message ?? "invalid"} at ${parsed.error.issues[0]?.path.join(".") ?? "?"}); use --restart to start over or another --out`,
    );
  }
  return parsed.data;
}

export function writeRunFile(directory: string, run: RunFile): void {
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(join(directory, RUN_FILE), `${JSON.stringify(run, null, 2)}\n`);
}

/** Names the first input that differs between two fingerprints. */
export function describeMismatch(saved: RunFingerprint, current: RunFingerprint): string {
  const keys = new Set([...Object.keys(saved.inputs), ...Object.keys(current.inputs)]);
  for (const key of [...keys].sort()) {
    if (JSON.stringify(saved.inputs[key]) !== JSON.stringify(current.inputs[key])) {
      return key;
    }
  }
  return "the run settings";
}

// ---------------------------------------------------------------------------------------------
// The run directory: ownership and lock
// ---------------------------------------------------------------------------------------------

/** Files this harness writes (and so may delete on `--restart`). */
const OWN_FILE =
  /^(run\.json|run\.lock|decisions\.jsonl|performance\.json|report-[a-z0-9._+-]+\.(md|json))(\.tmp)?$/;

export function isHarnessFile(name: string): boolean {
  return OWN_FILE.test(name);
}

export interface RunDirectoryState {
  readonly saved: RunFile | undefined;
  readonly hasDecisions: boolean;
  /** Files in the directory that this harness did not write. */
  readonly foreign: readonly string[];
}

export function inspectRunDirectory(directory: string): RunDirectoryState {
  const names = existsSync(directory) ? readdirSync(directory) : [];
  return {
    saved: readRunFile(directory),
    hasDecisions: names.includes(DECISIONS_FILE),
    foreign: names.filter((name) => !isHarnessFile(name)),
  };
}

/** Deletes this harness's own files, nothing else; refuses a directory with foreign files. */
export function clearRunDirectory(directory: string): void {
  const { foreign } = inspectRunDirectory(directory);
  if (foreign.length > 0) {
    throw new RunDirectoryError(
      `${directory} holds files that sib backtest did not write (${foreign.slice(0, 3).join(", ")}); nothing was deleted. Use an empty or dedicated --out.`,
    );
  }
  for (const name of readdirSync(directory)) {
    if (name !== LOCK_FILE) {
      unlinkSync(join(directory, name));
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the directory's lock: one process at a time per `--out`. A lock left by a process that is
 * gone is taken over. Returns the function that releases it.
 */
export function acquireLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx");
      writeFileSync(descriptor, `${process.pid}\n`);
      closeSync(descriptor);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) {
        throw new RunDirectoryError(
          `${directory} is in use by another sib backtest (process ${owner}); wait for it or use another --out`,
        );
      }
      unlinkSync(path); // stale: its process is gone
    }
  }
  throw new RunDirectoryError(`cannot lock ${directory}`);
}
