import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { DATABASE_FILE } from "./data-dir.js";
import { buildExport } from "./ledger/export.js";
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

/** What `--all-data` removes besides the photos: the database, its WAL files, logs. */
const DATABASE_FILES = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`];
const LOG_DIR = "logs";

/**
 * `sib delete-photos [--all-data]` (AC-015.3). After a confirmation prompt it removes every photo
 * with the rows derived from them (quotes made with a photo, the inspector's and judge's
 * decisions, answers that named a photo), overwrites the freed pages and truncates the WAL.
 * With `--all-data` it also removes the database, its WAL files, the logs and the weather cache
 * (a table of the database): nothing of the household stays in the data folder. Stop the app
 * first; the prompt says so. Returns true when something was deleted.
 */
export async function deletePhotosCommand(
  runtime: Runtime,
  options: DeleteOptions,
  io: { readonly confirm: Confirm; readonly print: Print },
): Promise<boolean> {
  const { db, dataDir } = runtime;
  const photos = new PhotoStore(join(dataDir, PHOTOS_DIR));
  photos.warn = io.print;
  let wipe = false;
  try {
    const confirmed = options.allData
      ? await io.confirm(
          `This deletes ALL data in ${dataDir}: every bet, card, verdict, photo, the database, logs and the weather cache. Stop the app first. It cannot be undone.\nType "${CONFIRM_ALL}" to continue: `,
          CONFIRM_ALL,
        )
      : await io.confirm(
          `This deletes every photo, and what Gemma read from them, in ${dataDir}. Bets and points stay. Stop the app first.\nType "${CONFIRM_PHOTOS}" to continue: `,
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
    removeAllRows(runtime, photos);
    wipe = true;
    return true;
  } finally {
    db.close();
    if (wipe) {
      removeDataFiles(dataDir, io.print);
    }
  }
}

/** Empties every table so the freed pages are overwritten (`secure_delete`), then truncates the WAL. */
function removeAllRows(runtime: Runtime, photos: PhotoStore): void {
  const { db } = runtime;
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
  checkpointAfterDelete({ db, photos });
}

function removeDataFiles(dataDir: string, print: Print): void {
  for (const name of DATABASE_FILES) {
    rmSync(join(dataDir, name), { force: true });
  }
  rmSync(join(dataDir, LOG_DIR), { recursive: true, force: true });
  for (const name of readdirSync(dataDir)) {
    if (name.endsWith(".log")) {
      unlinkSync(join(dataDir, name));
    }
  }
  const photosDir = join(dataDir, PHOTOS_DIR);
  if (existsSync(photosDir) && readdirSync(photosDir).length === 0) {
    rmdirSync(photosDir);
  }
  print("Removed the database, its WAL files, the logs and the weather cache.");
}

/**
 * `sib export <dir>` (AC-015.4): writes `export.json` (bets, decisions, verdicts, answers and
 * totals) and copies the photo files to `<dir>/photos/`. The folder must be new or empty, and is
 * created owner-only: it holds household data, so keep it out of the repository.
 */
export function exportCommand(
  runtime: Runtime,
  directory: string,
  print: Print,
  nowMs: number = Date.now(),
): void {
  const { db, dataDir } = runtime;
  try {
    const target = resolve(directory);
    if (existsSync(target)) {
      if (!statSync(target).isDirectory() || readdirSync(target).length > 0) {
        throw new Error(`${target} exists and is not an empty folder; choose a new one.`);
      }
    } else {
      mkdirSync(target, { recursive: true, mode: 0o700 });
    }
    chmodSync(target, 0o700);
    const document = db.transaction(() => buildExport(db, nowMs)).immediate();
    const photosTarget = join(target, "photos");
    mkdirSync(photosTarget, { mode: 0o700 });
    let copied = 0;
    for (const photo of document.photos) {
      const name = photo.file.slice("photos/".length);
      const source = join(dataDir, PHOTOS_DIR, name);
      if (existsSync(source)) {
        copyFileSync(source, join(photosTarget, name));
        chmodSync(join(photosTarget, name), 0o600);
        copied += 1;
      }
    }
    writeFileSync(join(target, "export.json"), `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
    });
    print(
      `Exported ${String(document.bets.length)} bets, ${String(document.decisions.length)} Gemma decisions and ${String(copied)} photos to ${target}. It holds household data: keep it out of git.`,
    );
  } finally {
    db.close();
  }
}
