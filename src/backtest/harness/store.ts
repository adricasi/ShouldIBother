/**
 * Where a run keeps its progress: an append-only `decisions.jsonl` (one finished decision per
 * line, so a killed run loses at most the decision in flight) and a `run.json` with the run's
 * fingerprint. A run resumes only when the fingerprint matches (NFR-005, NFR-012).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export interface RunFile {
  readonly schemaVersion: 1;
  readonly fingerprint: RunFingerprint;
  readonly startedAt: string;
  /** The model behind each Gemma strategy, to refuse a resume on a changed or re-pulled model. */
  readonly models: Readonly<
    Record<string, { readonly tag: string; readonly digest: string | null }>
  >;
}

export class FingerprintMismatchError extends Error {
  override readonly name = "FingerprintMismatchError";
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
 * Parses a `decisions.jsonl` text. A last line cut off by a crash is dropped; a damaged line
 * anywhere else is an error, because skipping it would silently change the report.
 */
export function parseDecisionLines(text: string): DecisionRecord[] {
  const lines = text.split("\n");
  const lastLine = lines.findLastIndex((line) => line.trim() !== "");
  const records: DecisionRecord[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (index === lastLine) {
        return; // torn write of the last decision: it will be made again
      }
      throw new Error(`decisions.jsonl line ${index + 1} is not JSON`, { cause: error });
    }
    const parsed = decisionRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`decisions.jsonl line ${index + 1}: ${parsed.error.message}`);
    }
    records.push(parsed.data as DecisionRecord);
  });
  return records;
}

export const DECISIONS_FILE = "decisions.jsonl";
export const RUN_FILE = "run.json";

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
      const text = readFileSync(path, "utf8");
      for (const record of parseDecisionLines(text)) {
        store.remember(record);
      }
      // Drop a torn last line now, so the next append starts on a clean line.
      writeFileSync(
        path,
        store
          .records()
          .map((record) => JSON.stringify(record))
          .join("\n") + (store.records().length > 0 ? "\n" : ""),
      );
    }
    return store;
  }

  override append(record: DecisionRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    this.remember(record);
  }
}

export function readRunFile(directory: string): RunFile | undefined {
  const path = join(directory, RUN_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as RunFile;
}

export function writeRunFile(directory: string, run: RunFile): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, RUN_FILE), `${JSON.stringify(run, null, 2)}\n`);
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
