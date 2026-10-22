import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { processPhoto } from "./process.js";

/** Folder inside the data folder that holds the photo files. */
export const PHOTOS_DIR = "photos";

const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;
export const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StoredPhoto {
  /** Random UUID; also the file's name without the extension. */
  readonly id: string;
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The photo files of the household (design.md, "Photo store"): owner-only folder (0700) and files
 * (0600) inside the data folder, random UUID names that say nothing about the picture. The
 * database row names the file; the store refuses any name that is not one it generated, so a row
 * can never point outside the folder.
 */
export class PhotoStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((statSync(dir).mode & 0o077) !== 0) {
      chmodSync(dir, 0o700);
    }
  }

  /** Re-encodes `bytes` (no metadata, ≤ 1024 px) and writes the result; throws `UnsupportedPhotoError`. */
  async save(bytes: Buffer): Promise<StoredPhoto> {
    const processed = await processPhoto(bytes);
    const id = randomUUID();
    const file = `${id}.jpg`;
    // `wx`: never overwrite; the mode applies from creation.
    writeFileSync(this.pathOf(file), processed.data, { flag: "wx", mode: 0o600 });
    return { id, file, width: processed.width, height: processed.height };
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

  private pathOf(file: string): string {
    if (!FILE_NAME.test(file)) {
      throw new Error("Not a photo file name");
    }
    return join(this.dir, file);
  }
}
