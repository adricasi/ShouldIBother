import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Db } from "./db.js";
import { DATABASE_FILE } from "./data-dir.js";
import { EXPORT_PHOTOS_DIR, buildExport } from "./ledger/export.js";
import { checkpointAfterDelete, deleteAllPhotos } from "./ledger/photos.js";
import { PHOTOS_DIR, PhotoStore } from "./photos/store.js";
import type { Runtime } from "./runtime.js";

type Print = (text: string) => void;

/** Asks a question on the console; true only for the exact confirmation word. */
export type Confirm = (question: string, expected: string) => Promise<boolean>;

export interface DeleteOptions {
  readonly allData: boolean;
}

/** The word the person types to confirm; anything else cancels. */
export const CONFIRM_PHOTOS = "yes";
export const CONFIRM_ALL = "delete everything";

/** The files the app owns in the data folder: the database and its WAL files. Nothing else. */
const DATABASE_FILES = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`];

export const STOP_THE_APP_FIRST =
  "Stop the app first: the database is in use. Nothing was changed.";

/**
 * Takes the database for this command alone, or fails. With the app running the database is open
 * in another process; an exclusive locking mode cannot be taken then (SQLite answers BUSY, also
 * when the other connection is idle), so a running app is refused before anything is read,
 * deleted or copied. Held until the connection closes.
 */
export function lockDatabase(db: Db): void {
  try {
    db.pragma("busy_timeout = 0");
    db.pragma("locking_mode = EXCLUSIVE");
    db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
    db.exec("BEGIN EXCLUSIVE");
    db.exec("ROLLBACK");
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY")) {
      throw new Error(STOP_THE_APP_FIRST, { cause: error });
    }
    throw error;
  }
}

/**
 * `sib delete-photos [--all-data]` (AC-015.3). It refuses while the app runs. After a confirmation
 * prompt it removes every photo with the rows derived from them (quotes made with a photo, the
 * inspector's and judge's decisions, answers that named a photo), overwrites the freed pages and
 * truncates the WAL. With `--all-data` it also removes the database and its WAL files, which holds
 * the weather cache: nothing of the household stays in the data folder. Only files the app owns
 * are removed (logs go to stdout; no log files are kept here, and `config/household.json` lives
 * outside the data folder; onboarding answers are rows of the database and go with it). If the
 * WAL cannot be truncated nothing is unlinked. Returns true when something was deleted.
 */
export async function deletePhotosCommand(
  runtime: Runtime,
  options: DeleteOptions,
  io: { readonly confirm: Confirm; readonly print: Print },
): Promise<boolean> {
  const { db, dataDir } = runtime;
  let wipe = false;
  try {
    lockDatabase(db);
    const photos = new PhotoStore(join(dataDir, PHOTOS_DIR));
    photos.warn = io.print;
    const confirmed = options.allData
      ? await io.confirm(
          `This deletes ALL app data in ${dataDir}: every bet, card, verdict and photo, the database and the weather cache. Your settings in config/household.json live outside this folder and are kept; answers given on the Household screen (onboarding), the place name included, are in the database and are deleted with it. Logs go to the terminal and are not touched. It cannot be undone.\nType "${CONFIRM_ALL}" to continue: `,
          CONFIRM_ALL,
        )
      : await io.confirm(
          `This deletes every photo, and what Gemma read from them, in ${dataDir}. Bets and points stay.\nType "${CONFIRM_PHOTOS}" to continue: `,
          CONFIRM_PHOTOS,
        );
    if (!confirmed) {
      io.print("Cancelled. Nothing was deleted.");
      return false;
    }
    const removed = deleteAllPhotos({ db, photos });
    io.print(`Deleted ${String(removed)} photo${removed === 1 ? "" : "s"}.`);
    if (!options.allData) {
      return true;
    }
    removeAllRows(db);
    if (!checkpointAfterDelete({ db, photos })) {
      throw new Error(
        "The database could not be cleaned (the WAL did not truncate); the database files were not removed.",
      );
    }
    wipe = true;
    return true;
  } finally {
    db.close();
    if (wipe) {
      removeDataFiles(dataDir, io.print);
    }
  }
}

/** Empties every table so the freed pages are overwritten (`secure_delete`). */
function removeAllRows(db: Db): void {
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name);
  db.transaction(() => {
    for (const table of tables) {
      db.prepare(`DELETE FROM "${table}"`).run();
    }
  }).immediate();
}

function removeDataFiles(dataDir: string, print: Print): void {
  for (const name of DATABASE_FILES) {
    rmSync(join(dataDir, name), { force: true });
  }
  const photosDir = join(dataDir, PHOTOS_DIR);
  if (existsSync(photosDir) && readdirSync(photosDir).length === 0) {
    rmdirSync(photosDir);
  }
  print("Removed the database, its WAL files and the weather cache.");
}

/**
 * The folder an export goes to: a new one (created owner-only, its parent must exist or is
 * created), or an existing real, empty folder. A symlink, a file or a folder with files in it is
 * refused, so an export never writes through a link or into someone else's files.
 */
function prepareExportFolder(target: string): void {
  let entry;
  try {
    entry = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (entry === undefined) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // Not recursive: fails with EEXIST if the folder appeared in the meantime.
    mkdirSync(target, { mode: 0o700 });
    return;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory() || readdirSync(target).length > 0) {
    throw new Error(`${target} is not a new or empty folder (links are refused); choose another.`);
  }
  chmodSync(target, 0o700);
}

/**
 * `sib export <dir>` (AC-015.4). It refuses while the app runs. Writes `export.json` (bets,
 * decisions, verdicts, answers and totals) and copies the photo files to `<dir>/photos/`. The
 * folder must be new or empty and is owner-only; files are never overwritten. It holds household
 * data: keep it out of the repository.
 */
export function exportCommand(
  runtime: Runtime,
  directory: string,
  print: Print,
  nowMs: number = Date.now(),
): void {
  const { db, dataDir } = runtime;
  try {
    lockDatabase(db);
    const target = resolve(directory);
    prepareExportFolder(target);
    const document = db.transaction(() => buildExport(db, nowMs))();
    const photosTarget = join(target, EXPORT_PHOTOS_DIR);
    mkdirSync(photosTarget, { mode: 0o700 });
    const store = new PhotoStore(join(dataDir, PHOTOS_DIR));
    let copied = 0;
    let skipped = 0;
    for (const photo of document.photos) {
      if (!store.exists(photo.file)) {
        skipped += 1;
        continue;
      }
      const destination = join(photosTarget, photo.file);
      copyFileSync(store.pathFor(photo.file), destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
      copied += 1;
    }
    writeFileSync(join(target, "export.json"), `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    print(
      `Exported ${String(document.bets.length)} bets, ${String(document.decisions.length)} Gemma decisions and ${String(copied)} photos to ${target}. It holds household data: keep it out of git.`,
    );
    if (skipped > 0) {
      print(
        `${String(skipped)} photo file${skipped === 1 ? " was" : "s were"} missing and not copied.`,
      );
    }
  } finally {
    db.close();
  }
}
