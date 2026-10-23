/**
 * The fixed synthetic habit profile (AC-019.6, AC-018.4, AGENTS.md): the habits every fine-tune
 * row and every backtest prompt show to the bookmaker. It is invented, committed in
 * `training/habits.synthetic.json`, and never read from `config/household.json`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

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
