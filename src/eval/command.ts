/**
 * `sib eval <job>`: runs a staged case set through one Gemma job and reports whether it meets
 * the target of NFR-004 (at least 19 of 20 schema-valid answers, tool use for the bookmaker,
 * photo judgement within 15 s). It calls the real job functions through the real job runner on
 * the configured model, so what it measures is what the live app gets (T-010, T-030).
 *
 *   sib eval <listener|bookmaker|inspector|judge|safety|laundry-planner|advisor>
 *            [--cases <file>] [--photos <dir>] [--out <dir>] [--record-fixtures <dir>] [--help]
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import { MADRID_TIME_ZONE, madridDateOf, madridParts } from "../domain/time.js";
import { parseRulesConfig, type RulesConfig } from "../domain/rules/index.js";
import { CONFIG_DIR, readJsonFile } from "../server/config.js";
import { loadAdviceRules } from "../server/advice-rules.js";
import { resolveDataDir } from "../server/data-dir.js";
import { createFakeServices } from "../server/fakes.js";
import { JOB_DEADLINE_MS, MODEL_CALL_TIMEOUT_MS } from "../server/gemma/runner.js";
import type { ModelClient, ModelHealth } from "../server/model/client.js";
import { loadModelsConfig } from "../server/model/config.js";
import { selectModel } from "../server/model/select.js";
import {
  MAX_UPLOAD_BYTES,
  processPhoto,
  UnsupportedPhotoError,
  type ProcessedPhoto,
} from "../server/photos/process.js";

import { CaseFileError, EVAL_JOBS, defaultCasesPath, isEvalJob } from "./cases.js";
import { EVAL_JOB_SPECS, EvalCaseError } from "./jobs.js";
import { assertNotCommittable, OutputGuardError } from "./output-guard.js";
import { assertCandidateFolder, recordedJobs, writeCandidateFixtures } from "./record-fixtures.js";
import {
  buildReport,
  columnWidths,
  renderHeader,
  renderMarkdown,
  renderRow,
  serializeReport,
  summaryLines,
  FAKE_WARNING,
  type ReportMeta,
} from "./report.js";
import { ModelUnreachableError, runEval } from "./run.js";
import { summarize } from "./summary.js";

export const EVAL_USAGE =
  `Usage: sib eval <${EVAL_JOBS.join("|")}> [--cases <file>] [--photos <dir>] [--out <dir>] ` +
  "[--record-fixtures <dir>] [--help]";

export const EVAL_HELP = [
  EVAL_USAGE,
  "",
  "  --cases <file>            case set (default evals/<job>/cases.json)",
  "  --photos <dir>            folder with the staged photos the cases name (inspector, judge photo set)",
  "  --out <dir>               where report.json and report.md go (default <data folder>/evals/<job>-<date>);",
  "                            refused inside the repository unless git ignores it, and never overwritten",
  "  --record-fixtures <dir>   also write the model's raw answers as candidate fixtures, <dir>/<job>/<case>.json,",
  "                            for a hand review; existing files are never overwritten (real model only)",
  "",
  "Exit codes:",
  "  0  target met (at least 19 of 20 valid, plus tool use or photo time where the job has them)",
  "  1  bad option, case file, photo folder or output folder",
  "  2  Gemma unreachable (or stopped answering during the run)",
  "  3  target missed",
].join("\n");

export const EVAL_EXIT = { met: 0, usage: 1, modelUnreachable: 2, targetMissed: 3 } as const;

class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface EvalDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly configDir?: string;
  /** Epoch milliseconds for the report date and default folder name. */
  readonly now?: () => number;
  /** Replaces the model selection (tests). The default is Ollama, or the fake with SIB_FAKE_MODEL=1. */
  readonly createModel?: () => Promise<{
    readonly model: ModelClient;
    readonly mode: "ollama" | "fake";
    readonly warmUp?: () => Promise<ModelHealth>;
  }>;
  readonly fetch?: typeof fetch;
  /** Shorter limits than the live 30 s / 45 s (tests). */
  readonly callTimeoutMs?: number;
  readonly deadlineMs?: number;
}

const two = (value: number): string => String(value).padStart(2, "0");

/** `2026-10-23 14:00:00 Europe/Madrid`: all times in the app are Madrid time. */
function madridStamp(epochMs: number): string {
  const t = madridParts(epochMs);
  return `${madridDateOf(epochMs)} ${two(t.hour)}:${two(t.minute)}:${two(t.second)} ${MADRID_TIME_ZONE}`;
}

/** `20261023-140000`, for the default report folder. */
function folderStamp(epochMs: number): string {
  const t = madridParts(epochMs);
  return `${madridDateOf(epochMs).replaceAll("-", "")}-${two(t.hour)}${two(t.minute)}${two(t.second)}`;
}

/** The staged photos, through the app's own photo pipeline; every problem is named before any model call. */
async function loadPhotos(
  dir: string | undefined,
  needed: readonly { readonly name: string; readonly staging: string }[],
): Promise<Map<string, ProcessedPhoto>> {
  const photos = new Map<string, ProcessedPhoto>();
  if (needed.length === 0) {
    return photos;
  }
  if (dir === undefined) {
    throw new UsageError(
      `These cases need staged photos: pass --photos <dir>. Expected files, for example:\n` +
        needed
          .slice(0, 5)
          .map((photo) => `  ${photo.name}: ${photo.staging}`)
          .join("\n") +
        (needed.length > 5 ? `\n  ... and ${needed.length - 5} more (see the case file)` : ""),
    );
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new UsageError(`--photos ${dir} is not a folder`);
  }
  const names = [...new Map(needed.map((photo) => [photo.name, photo])).values()];
  const missing = names.filter((photo) => !existsSync(join(dir, photo.name)));
  if (missing.length > 0) {
    throw new UsageError(
      `${missing.length} staged photo(s) missing in ${dir}:\n` +
        missing.map((photo) => `  ${photo.name}: ${photo.staging}`).join("\n"),
    );
  }
  for (const photo of names) {
    const path = join(dir, photo.name);
    let bytes: Buffer;
    try {
      // A folder or a pipe named like a photo must not be read (a pipe would hang).
      const info = statSync(path);
      if (!info.isFile()) {
        throw new UsageError(`${path} is not a regular file`);
      }
      if (info.size > MAX_UPLOAD_BYTES) {
        throw new UsageError(`${path} is larger than the 10 MB upload limit`);
      }
      bytes = readFileSync(path);
    } catch (error) {
      throw error instanceof UsageError
        ? error
        : new UsageError(
            `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
    }
    try {
      photos.set(photo.name, await processPhoto(bytes));
    } catch (error) {
      if (error instanceof UnsupportedPhotoError) {
        throw new UsageError(`${path} is not a usable photo: ${error.message}`);
      }
      throw error;
    }
  }
  return photos;
}

function loadRules(configDir: string): RulesConfig {
  return parseRulesConfig(readJsonFile(join(configDir, "rules.json")));
}

export async function evalCommand(
  args: readonly string[],
  print: (text: string) => void,
  deps: EvalDeps = {},
): Promise<number> {
  try {
    return await runEvalCommand(args, print, deps);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof CaseFileError ||
      error instanceof EvalCaseError ||
      error instanceof OutputGuardError
    ) {
      print(`${error.message}\n${EVAL_USAGE}`);
      return EVAL_EXIT.usage;
    }
    if (error instanceof ModelUnreachableError) {
      print(`${error.message}. No report was written.`);
      return EVAL_EXIT.modelUnreachable;
    }
    throw error;
  }
}

async function runEvalCommand(
  args: readonly string[],
  print: (text: string) => void,
  deps: EvalDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  const configDir = deps.configDir ?? CONFIG_DIR;
  const now = deps.now ?? Date.now;

  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        cases: { type: "string" },
        photos: { type: "string" },
        out: { type: "string" },
        "record-fixtures": { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) {
    print(EVAL_HELP);
    return EVAL_EXIT.met;
  }
  const [job, ...extra] = parsed.positionals;
  if (!isEvalJob(job) || extra.length > 0) {
    throw new UsageError(job === undefined ? "Name the job to evaluate." : `Unknown job: ${job}`);
  }
  const spec = EVAL_JOB_SPECS[job];
  const casesPath = resolve(parsed.values.cases ?? defaultCasesPath(job));
  const cases = spec.prepare(casesPath);
  const photos = await loadPhotos(
    parsed.values.photos,
    cases.flatMap((entry) => entry.photos),
  );

  // Every output location is checked before the model is asked anything.
  const date = madridStamp(now());
  const outDir = resolve(
    parsed.values.out ?? join(resolveDataDir(env), "evals", `${job}-${folderStamp(now())}`),
  );
  const reportJson = join(outDir, "report.json");
  const reportMd = join(outDir, "report.md");
  assertNotCommittable([reportJson, reportMd]);
  if (existsSync(reportJson) || existsSync(reportMd)) {
    throw new UsageError(
      `${outDir} already holds a report; use another --out so it is not overwritten`,
    );
  }
  const recordDir = parsed.values["record-fixtures"];
  if (recordDir !== undefined) {
    // Also before the model is asked: a refused folder must not cost a GPU run.
    assertCandidateFolder(resolve(recordDir), recordedJobs(job));
  }

  const modelsConfig = loadModelsConfig(join(configDir, "models.json"));
  const useFake = env["SIB_FAKE_MODEL"] === "1";
  if (recordDir !== undefined && useFake) {
    throw new UsageError(
      "--record-fixtures needs the real model: fixtures must not come from the fake",
    );
  }
  let selection;
  try {
    selection =
      deps.createModel === undefined
        ? await selectModel(modelsConfig, {
            useFake,
            fake: () => createFakeServices(now).model,
            ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          })
        : await deps.createModel();
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (selection.mode === "fake") {
    print(FAKE_WARNING);
  }
  if (recordDir !== undefined && selection.mode === "fake") {
    throw new UsageError(
      "--record-fixtures needs the real model: fixtures must not come from the fake",
    );
  }

  let health = await selection.model.health();
  if (health.state === "offline") {
    print(
      `Gemma is unreachable: ${health.detail ?? "no answer"}. Start Ollama and pull the model, then run it again.`,
    );
    return EVAL_EXIT.modelUnreachable;
  }
  if (selection.warmUp !== undefined) {
    // Load the model before the first measured case, so its first latency is not the load time.
    print("Loading the model ...");
    health = await selection.warmUp();
    if (health.state === "offline") {
      print(`Gemma is unreachable: ${health.detail ?? "warm-up failed"}.`);
      return EVAL_EXIT.modelUnreachable;
    }
  }

  const widths = columnWidths(cases.map((entry) => entry.id));
  print(`sib eval ${job}: ${cases.length} cases from ${basename(casesPath)}`);
  print(renderHeader(widths));
  const runs = await runEval({
    cases,
    model: selection.model,
    runner: {
      toolUse: modelsConfig.gemma.toolUse,
      answerMode: modelsConfig.gemma.answerMode,
      ...(deps.callTimeoutMs === undefined ? {} : { callTimeoutMs: deps.callTimeoutMs }),
      ...(deps.deadlineMs === undefined ? {} : { deadlineMs: deps.deadlineMs }),
    },
    rules: loadRules(configDir),
    // Only the advisor reads them, so the other jobs run without the file.
    ...(job === "advisor"
      ? { adviceRules: loadAdviceRules(join(configDir, "advice-rules.json")) }
      : {}),
    photos,
    onCase: (run, index) => {
      print(renderRow(run.record, index, widths));
    },
  });

  const records = runs.map((run) => run.record);
  const summary = summarize(records, spec);
  const answered = runs.flatMap((run) => run.calls).find((call) => call.model !== undefined);
  const meta: ReportMeta = {
    job,
    date,
    mode: selection.mode,
    health,
    model: answered?.model ?? null,
    modelDigest:
      runs.flatMap((run) => run.calls).find((call) => call.modelDigest !== undefined)
        ?.modelDigest ?? null,
    promptVersions: spec.promptVersions,
    runner: {
      toolUse: modelsConfig.gemma.toolUse,
      answerMode: modelsConfig.gemma.answerMode,
      callTimeoutMs: deps.callTimeoutMs ?? MODEL_CALL_TIMEOUT_MS,
      deadlineMs: deps.deadlineMs ?? JOB_DEADLINE_MS,
    },
    casesFile: basename(casesPath),
  };
  const report = buildReport(meta, records, summary);
  print("");
  for (const line of summaryLines(meta, summary)) {
    print(line);
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(reportJson, serializeReport(report), { flag: "wx", mode: 0o600 });
  writeFileSync(reportMd, renderMarkdown(report), { flag: "wx", mode: 0o600 });
  print(`Report: ${reportJson} and ${reportMd}`);

  if (recordDir !== undefined) {
    const { written, skipped } = writeCandidateFixtures(resolve(recordDir), runs, {
      model: meta.model ?? "unknown model",
      modelDigest: meta.modelDigest,
      date,
    });
    print(
      `Candidate fixtures: ${written.length} written to ${resolve(recordDir)}` +
        (skipped.length > 0 ? `, ${skipped.length} skipped because the file exists` : "") +
        ". Review them by hand before copying any into test/fixtures/gemma/.",
    );
  }
  return summary.targetMet ? EVAL_EXIT.met : EVAL_EXIT.targetMissed;
}
