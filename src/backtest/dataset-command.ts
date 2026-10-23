/**
 * `sib dataset`: builds the fine-tune dataset from a saved snapshot (REQ-019, T-031):
 * `train.jsonl`, a separate `holdout.jsonl` and `manifest.json`. Nothing is fetched.
 *
 *   sib dataset [--snapshot <dir>] [--out <dir>] [--habits <file>] [--prompt-version <n>] [--help]
 *
 * The prompt is the live `bookmaker.vN` (`--prompt-version` picks another one); after the prompt
 * is frozen, running the same command again rebuilds the dataset. Without `--habits` the rows
 * carry the fixed synthetic profile. The build stops, and writes nothing, if a value from
 * `config/household.json` appears in a row (AC-019.8).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parseRulesConfig } from "../domain/rules/index.js";
import { CONFIG_DIR } from "../server/config.js";
import { BOOKMAKER_PROMPT } from "../server/gemma/bookmaker.js";
import { loadPrompt, type Prompt } from "../server/gemma/prompts.js";
import { loadModelsConfig } from "../server/model/config.js";

import {
  DatasetBuildError,
  HOLDOUT_FILE,
  MANIFEST_FILE,
  TRAIN_FILE,
  buildFinetuneDataset,
} from "./finetune-dataset.js";
import { loadSyntheticHabits, readHabitsFile, type Habits } from "./habits.js";
import { writeFileAtomic } from "./harness/store.js";
import { HouseholdLeakError, loadHouseholdProbes } from "./household-guard.js";
import { OutputInsideRepositoryError, assertNotCommittable } from "./output-guard.js";
import { SnapshotLocationError, dataFolder, findSnapshotDirectory } from "./snapshot-location.js";
import { readSnapshot } from "./snapshot.js";

export const DATASET_USAGE =
  "Usage: sib dataset [--snapshot <dir>] [--out <dir>] [--habits <file>] [--prompt-version <n>] [--help]";

export const DATASET_HELP = [
  DATASET_USAGE,
  "",
  `Writes ${TRAIN_FILE} (Apr-Aug 2026), ${HOLDOUT_FILE} (1 Sep to the snapshot's last day, no answers)`,
  `and ${MANIFEST_FILE} (prompt version, rules hash, snapshot end date, habit profile, rows per chore and`,
  "band) to --out, by default <data folder>/datasets/<snapshot>/. The snapshot is the only one in",
  "<data folder>/data-snapshots/ or ./data-snapshots/ unless --snapshot says which.",
  "Same inputs, same bytes. Stops without writing if a value from config/household.json is in a row.",
].join("\n");

export interface DatasetDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly configDir?: string;
}

class UsageError extends Error {
  override readonly name = "UsageError";
}

function promptFor(version: string | undefined): Prompt {
  if (version === undefined) {
    return BOOKMAKER_PROMPT;
  }
  if (!/^[1-9]\d{0,2}$/.test(version)) {
    throw new UsageError(`--prompt-version must be a number like 1, got "${version}".`);
  }
  try {
    return loadPrompt("bookmaker", Number(version));
  } catch {
    throw new UsageError(`There is no prompts/bookmaker.v${version}.md.`);
  }
}

function readHabits(path: string | undefined): Habits {
  if (path === undefined) {
    return loadSyntheticHabits();
  }
  try {
    return readHabitsFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    throw new UsageError(
      `Cannot read the habits file ${path}: ${message.split("\n")[0] ?? message}`,
    );
  }
}

/** Runs `sib dataset`; returns the process exit code (0 written, 1 anything else). */
export async function datasetCommand(
  args: readonly string[],
  log: (line: string) => void,
  deps: DatasetDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.homeDir ?? homedir();
  const configDir = deps.configDir ?? CONFIG_DIR;
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        snapshot: { type: "string" },
        out: { type: "string" },
        habits: { type: "string" },
        "prompt-version": { type: "string" },
        help: { type: "boolean" },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    log(`${(error as Error).message}\n${DATASET_USAGE}`);
    return 1;
  }
  if (values.help === true) {
    log(DATASET_HELP);
    return 0;
  }

  try {
    const prompt = promptFor(values["prompt-version"]);
    const habits = readHabits(
      values.habits === undefined ? undefined : resolve(cwd, values.habits),
    );
    const rulesText = readFileSync(join(configDir, "rules.json"), "utf8");
    const rules = parseRulesConfig(JSON.parse(rulesText) as unknown);
    const models = loadModelsConfig(join(configDir, "models.json"));
    const probes = loadHouseholdProbes(configDir);

    let snapshotDirectory: string;
    try {
      snapshotDirectory = findSnapshotDirectory(values.snapshot, { cwd, home, env });
    } catch (error) {
      if (error instanceof SnapshotLocationError) {
        throw new UsageError(error.message);
      }
      throw error;
    }
    const snapshot = await readSnapshot(snapshotDirectory).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unreadable";
      throw new UsageError(
        `Cannot read the snapshot in ${snapshotDirectory}: ${message.split("\n")[0] ?? message}`,
      );
    });

    const out = resolve(
      cwd,
      values.out ?? join(dataFolder({ home, env }), "datasets", basename(snapshotDirectory)),
    );
    const files = [TRAIN_FILE, HOLDOUT_FILE, MANIFEST_FILE].map((name) => join(out, name));
    assertNotCommittable(files);

    log(`Building the dataset from ${snapshotDirectory} with ${prompt.version} ...`);
    const build = await buildFinetuneDataset(
      snapshot,
      {
        prompt,
        rules,
        rulesSha256: createHash("sha256").update(rulesText).digest("hex"),
        habits,
        toolUse: models.gemma.toolUse,
        answerMode: models.gemma.answerMode,
      },
      probes,
    );

    mkdirSync(out, { recursive: true });
    writeFileAtomic(join(out, TRAIN_FILE), build.trainJsonl);
    writeFileAtomic(join(out, HOLDOUT_FILE), build.holdoutJsonl);
    writeFileAtomic(join(out, MANIFEST_FILE), build.manifestJson);

    const rows = build.manifest.rows;
    log(`Dataset written to ${out}`);
    log(
      `  ${TRAIN_FILE}: ${rows.train.rows} rows, ${HOLDOUT_FILE}: ${rows.holdout.rows} rows (hold-out 1 Sep to ${snapshot.endDate}), ${MANIFEST_FILE}`,
    );
    for (const [chore, counts] of Object.entries(rows.train.by_chore)) {
      log(
        `  ${chore}: ${counts.total} train / ${rows.holdout.by_chore[chore as keyof typeof rows.holdout.by_chore].total} hold-out`,
      );
    }
    const skipped = Object.entries(rows.train.skipped)
      .map(([reason, count]) => `${reason} ${count}`)
      .join(", ");
    log(`  train days skipped: ${skipped}`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      log(`${error.message}\n${DATASET_USAGE}`);
      return 1;
    }
    if (error instanceof HouseholdLeakError) {
      log(`Dataset NOT written. ${error.message}`);
      return 1;
    }
    if (error instanceof DatasetBuildError || error instanceof OutputInsideRepositoryError) {
      log(`Dataset NOT written. ${error.message}`);
      return 1;
    }
    throw error;
  }
}
