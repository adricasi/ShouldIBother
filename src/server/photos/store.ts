import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { processPhoto } from "./process.js";

/** Folder inside the data folder that holds the photo files. */
export const PHOTOS_DIR = "photos";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FILE_NAME = new RegExp(`^${UUID}\\.jpg$`);
const TEMP_NAME = new RegExp(`^${UUID}\\.tmp$`);
export const PHOTO_ID = new RegExp(`^${UUID}$`);

/** A processed photo written to a temporary file, not yet a photo: `publish` makes it one. */
export interface StagedPhoto {
  /** Random UUID; also the file's name without the extension. */
  readonly id: string;
  /** The final name, `<id>.jpg`; what the `photos` row stores. */
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

export type StoredPhoto = StagedPhoto;

/**
 * The photo files of the household (design.md, "Photo store"): owner-only folder (0700) and files
 * (0600) inside the data folder, random UUID names that say nothing about the picture. The
 * database row names the file; the store refuses any name that is not one it generated, so a row
 * can never point outside the folder.
 *
 * A photo is written as `<uuid>.tmp`, its row is inserted, and only then is it renamed to
 * `<uuid>.jpg`, so a crash never leaves a photo file that a row does not know about under its
 * final name; `sweep` removes what a crash did leave (temporary files, `.jpg` files with no row).
 */
export class PhotoStore {
  private uploading = false;

  /** Where a problem that does not stop the request goes (never photo content). */
  warn: (message: string) => void = (message) => {
    console.error(message);
  };

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((statSync(dir).mode & 0o077) !== 0) {
      chmodSync(dir, 0o700);
    }
  }

  /** One upload is processed at a time (one household, and decoding is the costly part). */
  beginUpload(): boolean {
    if (this.uploading) {
      return false;
    }
    this.uploading = true;
    return true;
  }

  endUpload(): void {
    this.uploading = false;
  }

  /** Re-encodes `bytes` (no metadata, ≤ 1024 px) into a temporary file; throws `UnsupportedPhotoError`. */
  async stage(bytes: Buffer): Promise<StagedPhoto> {
    const processed = await processPhoto(bytes);
    const id = randomUUID();
    // `wx`: never overwrite; the mode applies from creation.
    writeFileSync(join(this.dir, `${id}.tmp`), processed.data, { flag: "wx", mode: 0o600 });
    return { id, file: `${id}.jpg`, width: processed.width, height: processed.height };
  }

  /** Makes a staged photo the real file, once its row is committed. */
  publish(photo: StagedPhoto): void {
    renameSync(join(this.dir, `${photo.id}.tmp`), this.pathOf(photo.file));
  }

  /** Drops a staged photo whose row was never committed. */
  discard(photo: StagedPhoto): void {
    this.removeTemporary(`${photo.id}.tmp`);
  }

  read(file: string): Buffer {
    return readFileSync(this.pathOf(file));
  }

  /** Deletes the file; a file that is already gone is fine (a delete can be repeated). */
  remove(file: string): void {
    try {
      unlinkSync(this.pathOf(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * Deletes files after their rows are gone. A failure is logged and not thrown: the delete has
   * happened for the person, and the next start's sweep removes the file.
   */
  removeAfterCommit(files: readonly string[]): void {
    for (const file of files) {
      try {
        this.remove(file);
      } catch (error) {
        this.warn(
          `Could not remove a deleted photo file (${(error as NodeJS.ErrnoException).code ?? "error"}); the next start removes it`,
        );
      }
    }
  }

  /**
   * Removes what a crash or a failed delete left: every temporary file, and every photo file no
   * row names. Returns how many files it removed. Run at start, before any request.
   */
  sweep(knownFiles: ReadonlySet<string>): number {
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      const orphan = TEMP_NAME.test(name) || (FILE_NAME.test(name) && !knownFiles.has(name));
      if (!orphan) {
        continue;
      }
      try {
        unlinkSync(join(this.dir, name));
        removed += 1;
      } catch (error) {
        this.warn(
          `Could not remove an orphan photo file (${(error as NodeJS.ErrnoException).code ?? "error"})`,
        );
      }
    }
    return removed;
  }

  private removeTemporary(name: string): void {
    try {
      unlinkSync(join(this.dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warn("Could not remove a temporary photo file; the next start removes it");
      }
    }
  }

  private pathOf(file: string): string {
    if (!FILE_NAME.test(file)) {
      throw new Error("Not a photo file name");
    }
    return join(this.dir, file);
  }
}
