import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import { writeSnapshot, type WeatherSnapshot } from "../../../src/backtest/index.js";
import { syntheticSnapshot } from "../support/synthetic-weather.js";
import { loadRules } from "../../../src/server/rules.js";
import { loadSavings } from "../../../src/server/savings.js";

export const RULES = loadRules();
export const CATALOGUE = loadSavings();

/** A two-week synthetic slice that crosses 1 Sep: the last days of the training period and the hold-out. */
export function sliceSnapshot(
  options: Parameters<typeof syntheticSnapshot>[0] = {},
): Promise<WeatherSnapshot> {
  return syntheticSnapshot({
    startDate: "2026-08-24",
    requestedEndDate: "2026-09-06",
    ...options,
  });
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

export function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "sib-backtest-"));
  directories.push(directory);
  return directory;
}

/** Writes the snapshot where `sib backtest --snapshot` reads it. */
export async function snapshotOnDisk(snapshot: WeatherSnapshot): Promise<string> {
  return writeSnapshot(tempDir(), snapshot);
}
