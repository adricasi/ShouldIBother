import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import {
  buildFinetuneDataset,
  loadHouseholdProbes,
  loadSyntheticHabits,
  type FinetuneBuild,
  type FinetuneRow,
  type WeatherSnapshot,
} from "../../../src/backtest/index.js";
import { CONFIG_DIR } from "../../../src/server/config.js";
import { BOOKMAKER_PROMPT } from "../../../src/server/gemma/bookmaker.js";
import { loadRules } from "../../../src/server/rules.js";

export const RULES = loadRules();

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

export function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "sib-finetune-"));
  directories.push(directory);
  return directory;
}

/**
 * A `config/` folder for the dataset command: the real rules and models, and a household file
 * with the values given (the committed example when none).
 */
export function configDirWith(household?: Record<string, unknown>): string {
  const directory = tempDir();
  for (const name of ["rules.json", "models.json", "household.example.json"]) {
    copyFileSync(join(CONFIG_DIR, name), join(directory, name));
  }
  if (household !== undefined) {
    writeFileSync(join(directory, "household.json"), JSON.stringify(household));
  }
  return directory;
}

/** The household values the committed example holds, as the probes every unit test builds with. */
export function exampleProbes() {
  return loadHouseholdProbes(configDirWith());
}

export function buildWith(
  snapshot: WeatherSnapshot,
  probes = exampleProbes(),
  overrides: { habits?: Record<string, string | boolean> } = {},
): Promise<FinetuneBuild> {
  return buildFinetuneDataset(
    snapshot,
    {
      prompt: BOOKMAKER_PROMPT,
      rules: RULES,
      rulesSha256: "0".repeat(64),
      habits: overrides.habits ?? loadSyntheticHabits(),
      toolUse: "native",
      answerMode: "single_call",
    },
    probes,
  );
}

/** The folder a command writes into, created inside a temp dir. */
export function outDir(): string {
  const directory = join(tempDir(), "out");
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function parseLines(jsonl: string): FinetuneRow[] {
  return jsonl
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as FinetuneRow);
}
