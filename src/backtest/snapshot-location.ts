/**
 * Where weather snapshots live. `sib snapshot` writes under the household data folder
 * (`~/.should-i-bother/data-snapshots/`, or `SIB_DATA_DIR`), outside the repository; `sib dataset`
 * and `sib backtest` look there, then in `./data-snapshots/` (git-ignored) for a snapshot made
 * with `--out data-snapshots`.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { SNAPSHOT_FILE_NAME } from "./snapshot.js";

export class SnapshotLocationError extends Error {
  override readonly name = "SnapshotLocationError";
}

export interface LocationContext {
  readonly cwd: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The data folder: `SIB_DATA_DIR` or `~/.should-i-bother` (not created here). */
export function dataFolder(context: Pick<LocationContext, "home" | "env">): string {
  const override = context.env["SIB_DATA_DIR"];
  return override !== undefined && override !== ""
    ? override
    : join(context.home, ".should-i-bother");
}

/** `<data folder>/data-snapshots`. */
export function defaultSnapshotRoot(context: Pick<LocationContext, "home" | "env">): string {
  return join(dataFolder(context), "data-snapshots");
}

function snapshotsIn(root: string): string[] {
  return existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && existsSync(join(root, entry.name, SNAPSHOT_FILE_NAME)),
        )
        .map((entry) => join(root, entry.name))
        .sort()
    : [];
}

/** The snapshot directory to read: the given one, or the only snapshot in the usual places. */
export function findSnapshotDirectory(given: string | undefined, context: LocationContext): string {
  if (given !== undefined) {
    return resolve(context.cwd, given);
  }
  const roots = [defaultSnapshotRoot(context), join(context.cwd, "data-snapshots")];
  const found = [...new Set(roots.flatMap(snapshotsIn))];
  if (found.length === 1) {
    return found[0] ?? "";
  }
  throw new SnapshotLocationError(
    found.length === 0
      ? "No snapshot found in data-snapshots/ (here or in the data folder). Run `sib snapshot` first or pass --snapshot <dir>."
      : `Several snapshots found (${found.map((dir) => basename(dir)).join(", ")}); pass --snapshot <dir>.`,
  );
}
