import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Name of the SQLite file inside the data folder. */
export const DATABASE_FILE = "sib.db";

/**
 * The household-private data folder (design.md, Data model): `~/.should-i-bother/`, or
 * `SIB_DATA_DIR`. Created owner-only when missing; an existing folder keeps its permissions.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SIB_DATA_DIR"];
  const dir =
    override !== undefined && override !== "" ? override : join(homedir(), ".should-i-bother");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
