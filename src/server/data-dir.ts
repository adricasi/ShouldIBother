import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Name of the SQLite file inside the data folder. */
export const DATABASE_FILE = "sib.db";

/**
 * The household-private data folder (design.md, Data model): `~/.should-i-bother/`, or
 * `SIB_DATA_DIR`. Created owner-only when missing. An existing folder with group or other
 * permissions is tightened to 0700; if that is not possible (not the owner) the start fails
 * rather than keeping household photos readable by other users.
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
  return dir;
}
