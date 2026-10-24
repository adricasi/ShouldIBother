import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { assertNotCommittable } from "../backtest/output-guard.js";

/** Name of the SQLite file inside the data folder. */
export const DATABASE_FILE = "sib.db";

/**
 * The household-private data folder (design.md, Data model): `~/.should-i-bother/`, or
 * `SIB_DATA_DIR`. Created owner-only when missing. An existing folder with group or other
 * permissions is tightened to 0700; if that is not possible (not the owner) the start fails
 * rather than keeping household photos readable by other users. A folder inside a git working tree
 * that git would not ignore is refused, so photos can never be committed by accident.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SIB_DATA_DIR"];
  const dir =
    override !== undefined && override !== "" ? override : join(homedir(), ".should-i-bother");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o077) !== 0) {
    try {
      chmodSync(dir, 0o700);
    } catch (error) {
      throw new Error(
        `Data folder ${dir} is accessible to other users and its permissions cannot be tightened: ${String(error)}`,
        { cause: error },
      );
    }
  }
  // Household photos and the database never live where git would commit them (NFR-002).
  assertNotCommittable([join(dir, DATABASE_FILE), join(dir, "photos", "photo.jpg")]);
  return dir;
}
