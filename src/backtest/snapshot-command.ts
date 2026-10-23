/**
 * `sib snapshot`: fetches the weather snapshot of the backtest and the fine-tune dataset from
 * Open-Meteo (Previous Runs day-1 forecasts, Historical Forecast, archive) and saves it outside
 * the repository (REQ-018, REQ-019, NFR-002).
 *
 *   sib snapshot [--out <dir>] [--start <date>] [--end <date>] [--help]
 *
 * The default folder is `<data folder>/data-snapshots/` (`~/.should-i-bother/`, or `SIB_DATA_DIR`).
 * A folder inside a git working tree is refused unless git ignores it.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { assertIsoDate, madridDateOf, addDays } from "../domain/outcomes.js";
import { DEFAULT_LOCATION } from "../server/config.js";

import { OutputInsideRepositoryError, assertNotCommittable } from "./output-guard.js";
import { defaultSnapshotRoot } from "./snapshot-location.js";
import {
  SNAPSHOT_FILE_NAME,
  fetchJsonWithTimeout,
  fetchSnapshot,
  snapshotDirectoryName,
  writeSnapshot,
  type FetchJson,
  type SnapshotLocation,
} from "./snapshot.js";
import { TRAINING_START_DATE } from "./target-band.js";

export const SNAPSHOT_USAGE =
  "Usage: sib snapshot [--out <dir>] [--start <date>] [--end <date>] [--help]";

export const SNAPSHOT_HELP = [
  SNAPSHOT_USAGE,
  "",
  "Fetches Previous Runs day-1 forecasts, Historical Forecast and archive hours for Gràcia from",
  `${TRAINING_START_DATE} (--start) to yesterday (--end) from Open-Meteo, and saves them under`,
  "<dir>/<place>_<start>_<end>/snapshot.json. The end date in the folder name is the archive's last",
  "complete day. The default <dir> is ~/.should-i-bother/data-snapshots (SIB_DATA_DIR to change);",
  "a folder inside a git working tree is refused unless git ignores it.",
].join("\n");

/** The place the snapshot is for: neighbourhood level, never the household's own coordinates. */
export const SNAPSHOT_LOCATION: SnapshotLocation = {
  name: "Gràcia, Barcelona",
  ...DEFAULT_LOCATION,
};

export interface SnapshotDeps {
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly homeDir?: string;
  /** Replaces the real Open-Meteo fetch (tests). */
  readonly fetchJson?: FetchJson;
}

/** Runs `sib snapshot`; returns the process exit code. */
export async function snapshotCommand(
  args: readonly string[],
  log: (line: string) => void,
  deps: SnapshotDeps = {},
): Promise<number> {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.homeDir ?? homedir();
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        out: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        help: { type: "boolean" },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    log(`${(error as Error).message}\n${SNAPSHOT_USAGE}`);
    return 1;
  }
  if (values.help === true) {
    log(SNAPSHOT_HELP);
    return 0;
  }

  try {
    const startDate = values.start ?? TRAINING_START_DATE;
    const endDate = values.end ?? addDays(madridDateOf(now()), -1);
    try {
      assertIsoDate(startDate);
      assertIsoDate(endDate);
    } catch {
      log(`--start and --end must be dates like 2026-04-01.\n${SNAPSHOT_USAGE}`);
      return 1;
    }
    if (endDate < startDate) {
      log(`--end ${endDate} is before --start ${startDate}.\n${SNAPSHOT_USAGE}`);
      return 1;
    }

    const root = resolve(cwd, values.out ?? defaultSnapshotRoot({ home, env }));
    // Before any request: the folder name is not known yet, so test two files inside the root.
    assertNotCommittable([join(root, "x", SNAPSHOT_FILE_NAME), join(root, "x", "README.md")]);

    log(`Fetching ${SNAPSHOT_LOCATION.name} ${startDate} to ${endDate} from Open-Meteo ...`);
    const snapshot = await fetchSnapshot({
      fetchJson: deps.fetchJson ?? fetchJsonWithTimeout,
      location: SNAPSHOT_LOCATION,
      startDate,
      requestedEndDate: endDate,
      fetchedAt: new Date(now()).toISOString(),
    });
    const name = snapshotDirectoryName(snapshot);
    assertNotCommittable([join(root, name, SNAPSHOT_FILE_NAME), join(root, name, "README.md")]);
    const directory = await writeSnapshot(root, snapshot);

    log(`Snapshot written: ${directory}`);
    log(
      `Days ${snapshot.startDate} to ${snapshot.endDate} (the archive's last complete day; requested up to ${snapshot.requestedEndDate}).`,
    );
    for (const [source, coverage] of Object.entries(snapshot.coverage)) {
      log(`  ${source}: ${coverage.hours} hours`);
    }
    log(snapshot.attribution);
    return 0;
  } catch (error) {
    if (error instanceof OutputInsideRepositoryError) {
      log(error.message);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`Snapshot failed: ${message.split("\n")[0] ?? message}`);
    return 1;
  }
}
