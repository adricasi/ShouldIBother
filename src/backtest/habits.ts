/**
 * The fixed synthetic habit profile (AC-019.6, AC-018.4, AGENTS.md): the habits every fine-tune
 * row and every backtest prompt show to the bookmaker. It is invented, committed in
 * `training/habits.synthetic.json`, and never read from `config/household.json`.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { CONFIG_DIR } from "../server/config.js";

import { dataFolder } from "./snapshot-location.js";

export type Habits = Readonly<Record<string, string | boolean>>;

/** Resolves to the repository root from both `src/backtest/` and `dist/backtest/`. */
export const SYNTHETIC_HABITS_PATH = fileURLToPath(
  new URL("../../training/habits.synthetic.json", import.meta.url),
);

const habitsSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));

export function parseHabits(text: string): Habits {
  return habitsSchema.parse(JSON.parse(text));
}

export function readHabitsFile(path: string): Habits {
  return parseHabits(readFileSync(path, "utf8"));
}

export function loadSyntheticHabits(): Habits {
  return readHabitsFile(SYNTHETIC_HABITS_PATH);
}

/** Keys sorted, so the same habits always give the same bytes and the same hash. */
export function sortedHabits(habits: Habits): Record<string, string | boolean> {
  return Object.fromEntries(Object.entries(habits).sort(([a], [b]) => a.localeCompare(b)));
}

/** Hash of the habits, or null for none; reports keep the hash, not the values. */
export function habitsDigest(habits: Habits): string | null {
  const entries = Object.entries(sortedHabits(habits));
  return entries.length === 0
    ? null
    : createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * True when a habits file looks like household data: under the data folder (`~/.should-i-bother/`
 * or `SIB_DATA_DIR`), named `household.json`, or the app's own `config/household.json`. A file like
 * that must not feed a backtest or a dataset (AC-018.4, AC-019.6, NFR-002).
 */
export function looksLikeHouseholdData(
  path: string,
  context: {
    readonly home: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): boolean {
  const real = (() => {
    try {
      return realpathSync(path);
    } catch {
      return path; // reported when the file is read
    }
  })();
  const folders = [join(context.home, ".should-i-bother"), dataFolder(context)];
  return (
    folders.some((folder) => real === folder || real.startsWith(`${folder}${sep}`)) ||
    real === join(CONFIG_DIR, "household.json") ||
    basename(real) === "household.json"
  );
}
