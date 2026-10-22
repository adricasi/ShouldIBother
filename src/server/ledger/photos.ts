import type { Db } from "../db.js";
import { HttpError } from "../problem.js";
import { UnsupportedPhotoError, UNSUPPORTED_PHOTO_MESSAGE } from "../photos/process.js";
import { PHOTO_ID } from "../photos/store.js";

import type { LedgerDeps } from "./deps.js";
import type { CardRow } from "./rows.js";

export interface PhotoRow {
  id: string;
  card_id: number | null;
  bet_id: number | null;
  role: "before" | "after" | "appeal";
  file: string;
  received_at: number;
  width: number;
  height: number;
}

/** What the HTTP layer shows of a stored photo: its id and where to fetch it. */
export function photoView(photo: PhotoRow) {
  return {
    id: photo.id,
    url: `/photos/${photo.id}`,
    role: photo.role,
    width: photo.width,
    height: photo.height,
    received_at: new Date(photo.received_at).toISOString(),
  };
}

export type PhotoView = ReturnType<typeof photoView>;

export function unsupportedPhoto(): HttpError {
  return new HttpError(415, "Unsupported photo format", UNSUPPORTED_PHOTO_MESSAGE);
}

/**
 * The refusals that keep a photo from being added to a card, in one place so they can be checked
 * twice: before the photo is processed (cheap, fast answer) and again inside the transaction that
 * inserts it, because the card can change while the photo is being decoded (a bet placed, Gemma
 * started on it, the card deleted).
 */
function assertCardTakesPhoto(db: Db, cardId: number): CardRow {
  const card = db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  if (card.kind !== "weather") {
    throw new HttpError(409, "No photo on this card", "Only a card with odds takes a photo.");
  }
  const bet = db
    .prepare<[number], { id: number }>(
      "SELECT id FROM bets WHERE card_id = ? AND status != 'undone' LIMIT 1",
    )
    .get(cardId);
  if (bet !== undefined) {
    throw new HttpError(
      409,
      "A bet is already placed on this card",
      "A photo can only sharpen odds before the bet.",
    );
  }
  if (card.photo_state === "inspecting") {
    throw new HttpError(
      409,
      "Gemma is still looking at the first photo",
      "Wait a moment, then send the next one.",
    );
  }
  if (card.gemma_state === "thinking") {
    // The first odds would otherwise land after the photo's and hide them.
    throw new HttpError(
      409,
      "Gemma is still setting the odds",
      "Add the photo in a moment, once the odds are in.",
    );
  }
  return card;
}

/**
 * Stores a before photo for a card (REQ-005): strips metadata and shrinks it first (AC-005.1),
 * and only then writes the row. A file that cannot be decoded is refused with 415 and leaves the
 * card, its quotes and the photo folder exactly as they were (AC-005.6). The file is written under
 * a temporary name, the row is inserted in a transaction that repeats every check, and the file
 * gets its final name only after the commit, so no refusal leaves a photo file behind.
 */
export async function addBeforePhoto(
  deps: Pick<LedgerDeps, "db" | "now" | "photos">,
  cardId: number,
  bytes: Buffer,
): Promise<{ card: CardRow; photo: PhotoRow }> {
  const card = assertCardTakesPhoto(deps.db, cardId);
  if (!deps.photos.beginUpload()) {
    throw new HttpError(
      409,
      "Another photo is being processed",
      "Wait a moment, then send the photo again.",
    );
  }
  try {
    let staged;
    try {
      staged = await deps.photos.stage(bytes);
    } catch (error) {
      throw error instanceof UnsupportedPhotoError ? unsupportedPhoto() : error;
    }
    // A new photo replaces the card's earlier one, with everything derived from it, so the odds
    // before the new photo are the odds without any photo.
    let replaced: PhotoRow[];
    try {
      replaced = deps.db
        .transaction((): PhotoRow[] => {
          assertCardTakesPhoto(deps.db, cardId);
          const old = deps.db
            .prepare<[number], PhotoRow>(
              "SELECT * FROM photos WHERE card_id = ? AND role = 'before'",
            )
            .all(cardId);
          removePhotoRows(
            deps.db,
            old.map((photo) => photo.id),
          );
          deps.db
            .prepare(
              `INSERT INTO photos (id, card_id, bet_id, role, file, received_at, width, height)
             VALUES (?, ?, NULL, 'before', ?, ?, ?, ?)`,
            )
            .run(staged.id, cardId, staged.file, deps.now(), staged.width, staged.height);
          return old;
        })
        .immediate();
    } catch (error) {
      // No row: do not leave a file nothing points to.
      deps.photos.discard(staged);
      throw error;
    }
    try {
      deps.photos.publish(staged);
    } catch (error) {
      deps.db.prepare("DELETE FROM photos WHERE id = ?").run(staged.id);
      deps.photos.discard(staged);
      throw error;
    }
    deps.photos.removeAfterCommit(replaced.map((photo) => photo.file));
    if (replaced.length > 0) {
      checkpointAfterDelete(deps);
    }
    const photo = deps.db
      .prepare<[string], PhotoRow>("SELECT * FROM photos WHERE id = ?")
      .get(staged.id)!;
    return { card, photo };
  } finally {
    deps.photos.endUpload();
  }
}

/**
 * Stores the after photo of a bet (AC-008.2): metadata stripped and shrunk first (AC-005.1), then
 * the row. An undecodable file is refused with 415 and nothing is written (AC-005.6). Like the
 * before photo it is staged under a temporary name and renamed after the commit; `record` runs
 * in the same transaction as the row, so the person's answer and its photo are stored together
 * or not at all.
 */
export async function addAfterPhoto(
  deps: Pick<LedgerDeps, "db" | "now" | "photos">,
  betId: number,
  bytes: Buffer,
  record: (photo: PhotoRow) => void,
): Promise<PhotoRow> {
  if (!deps.photos.beginUpload()) {
    throw new HttpError(
      409,
      "Another photo is being processed",
      "Wait a moment, then send the photo again.",
    );
  }
  try {
    let staged;
    try {
      staged = await deps.photos.stage(bytes);
    } catch (error) {
      throw error instanceof UnsupportedPhotoError ? unsupportedPhoto() : error;
    }
    let photo: PhotoRow;
    try {
      photo = deps.db
        .transaction((): PhotoRow => {
          deps.db
            .prepare(
              `INSERT INTO photos (id, card_id, bet_id, role, file, received_at, width, height)
               VALUES (?, NULL, ?, 'after', ?, ?, ?, ?)`,
            )
            .run(staged.id, betId, staged.file, deps.now(), staged.width, staged.height);
          const row = deps.db
            .prepare<[string], PhotoRow>("SELECT * FROM photos WHERE id = ?")
            .get(staged.id)!;
          record(row);
          return row;
        })
        .immediate();
    } catch (error) {
      deps.photos.discard(staged);
      throw error;
    }
    try {
      deps.photos.publish(staged);
    } catch (error) {
      deps.db.prepare("DELETE FROM photos WHERE id = ?").run(staged.id);
      deps.photos.discard(staged);
      throw error;
    }
    return photo;
  } finally {
    deps.photos.endUpload();
  }
}

/** The photo's row for serving; 404 for an unknown id or one that is not a UUID. */
export function getPhotoRow(db: Db, id: string): PhotoRow {
  const photo = PHOTO_ID.test(id)
    ? db.prepare<[string], PhotoRow>("SELECT * FROM photos WHERE id = ?").get(id)
    : undefined;
  if (photo === undefined) {
    throw new HttpError(404, "Photo not found");
  }
  return photo;
}

/**
 * Overwrites deleted rows in the database file: `secure_delete` zeroes the freed content when
 * the delete runs, and truncating the WAL after a checkpoint leaves no older copy of a page
 * behind (AC-015.2). A reader (the CLI) can keep the checkpoint from finishing: it is tried
 * again once after a short wait, and a warning (no content) is logged if it still cannot finish;
 * the next checkpoint, or the next start, completes it. Returns whether it finished.
 */
export function checkpointAfterDelete(deps: Pick<LedgerDeps, "db" | "photos">): boolean {
  // The connection's busy timeout (5 s) would make a delete wait on a slow reader; the checkpoint
  // is retried below instead, so it must not wait.
  const timeout = deps.db.pragma("busy_timeout", { simple: true }) as number;
  deps.db.pragma("busy_timeout = 0");
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [result] = deps.db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
      if (result === undefined || result.busy === 0) {
        return true;
      }
      if (attempt === 0) {
        // A short, synchronous pause: this runs once per delete, never in a loop.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  } finally {
    deps.db.pragma(`busy_timeout = ${String(timeout)}`);
  }
  deps.photos.warn(
    "The database checkpoint after a delete could not finish (another process is reading); deleted rows may stay in the WAL file until the next checkpoint",
  );
  return false;
}

/**
 * Deletes one photo and everything derived from it (AC-015.2): the `photos` row, the quotes made
 * with it, every Gemma decision that used it (the inspector's, the judge's, and the bookmaker
 * run that read the inspector's observations), and the file. The rows go in one transaction; the
 * file is unlinked after the commit, and one that cannot be unlinked is logged and swept at the
 * next start.
 */
export function deletePhoto(deps: Pick<LedgerDeps, "db" | "photos">, id: string): void {
  const photo = getPhotoRow(deps.db, id);
  deps.db
    .transaction(() => {
      removePhotoRows(deps.db, [photo.id]);
    })
    .immediate();
  deps.photos.removeAfterCommit([photo.file]);
  checkpointAfterDelete(deps);
}

/**
 * Deletes every photo, with what was derived from them (AC-015.3): the rows, their quotes and the
 * decisions that used them, then the files, and any photo file no row names. Returns how many
 * photo rows went.
 */
export function deleteAllPhotos(deps: Pick<LedgerDeps, "db" | "photos">): number {
  const photos = deps.db
    .transaction((): PhotoRow[] => {
      const all = deps.db.prepare<[], PhotoRow>("SELECT * FROM photos").all();
      removePhotoRows(
        deps.db,
        all.map((photo) => photo.id),
      );
      return all;
    })
    .immediate();
  deps.photos.removeAfterCommit(photos.map((photo) => photo.file));
  // What no row named (a crash left it) goes too.
  deps.photos.sweep(new Set());
  checkpointAfterDelete(deps);
  return photos.length;
}

/** Rows of photos, their quotes and their decisions; the card forgets its photo state. */
function removePhotoRows(db: Db, photoIds: readonly string[]): void {
  if (photoIds.length === 0) {
    return;
  }
  deleteDerivedOfPhotos(db, photoIds);
  const marks = photoIds.map(() => "?").join(", ");
  db.prepare(
    `UPDATE cards SET photo_state = NULL, photo_failure = NULL
     WHERE id IN (SELECT card_id FROM photos WHERE id IN (${marks}))`,
  ).run(...photoIds);
  db.prepare(`DELETE FROM photos WHERE id IN (${marks})`).run(...photoIds);
}

function deleteDerivedOfPhotos(db: Db, photoIds: readonly string[]): void {
  const markFor = (ids: readonly unknown[]): string => ids.map(() => "?").join(", ");
  const quoteDecisions = db
    .prepare<string[], { decision_id: number }>(
      `SELECT decision_id FROM quotes WHERE photo_id IN (${markFor(photoIds)}) AND decision_id IS NOT NULL`,
    )
    .all(...photoIds)
    .map((row) => row.decision_id);
  db.prepare(`DELETE FROM quotes WHERE photo_id IN (${markFor(photoIds)})`).run(...photoIds);
  db.prepare(`DELETE FROM gemma_decisions WHERE photo_id IN (${markFor(photoIds)})`).run(
    ...photoIds,
  );
  // The judge read the bet's before and after photo together: if either goes, every judge
  // decision on that bet goes with it (AC-015.2). The link is the settle progress row.
  db.prepare(
    `DELETE FROM gemma_decisions WHERE job = 'judge' AND bet_id IN (
       SELECT bet_id FROM settle_progress
       WHERE photo_id IN (${markFor(photoIds)}) OR before_photo_id IN (${markFor(photoIds)}))`,
  ).run(...photoIds, ...photoIds);
  for (const decisionId of quoteDecisions) {
    db.prepare("DELETE FROM gemma_decisions WHERE id = ?").run(decisionId);
  }
}

/**
 * Deletes a bet's data (AC-015.2): the bet, its settlements, the card's quotes and decisions, and
 * every photo of the bet or its card, files included. The card is household text too, so it goes
 * with them; the exception is an undone bet on a card that has a newer active bet, where only the
 * undone bet's own rows go and the card stays. The photo list is read and the rows are deleted in
 * one transaction (an upload cannot slip a photo in between); the files go after the commit.
 */
export function deleteBetData(deps: Pick<LedgerDeps, "db" | "photos">, betId: number): void {
  const files = deps.db
    .transaction((): string[] => {
      const bet = deps.db
        .prepare<[number], { id: number; card_id: number }>(
          "SELECT id, card_id FROM bets WHERE id = ?",
        )
        .get(betId);
      if (bet === undefined) {
        throw new HttpError(404, "Bet not found");
      }
      const otherActive = deps.db
        .prepare<[number, number], { id: number }>(
          "SELECT id FROM bets WHERE card_id = ? AND id != ? AND status != 'undone' LIMIT 1",
        )
        .get(bet.card_id, bet.id);
      const photos = otherActive
        ? deps.db.prepare<[number], PhotoRow>("SELECT * FROM photos WHERE bet_id = ?").all(bet.id)
        : deps.db
            .prepare<[number, number], PhotoRow>(
              `SELECT * FROM photos WHERE card_id = ?
                 OR bet_id IN (SELECT id FROM bets WHERE card_id = ?)`,
            )
            .all(bet.card_id, bet.card_id);
      if (otherActive === undefined) {
        // Cascades: bets, settlements, quotes, photos rows and decisions (migration 0002).
        deps.db.prepare("DELETE FROM cards WHERE id = ?").run(bet.card_id);
      } else {
        deps.db.prepare("DELETE FROM gemma_decisions WHERE bet_id = ?").run(bet.id);
        deps.db.prepare("DELETE FROM bets WHERE id = ?").run(bet.id);
      }
      return photos.map((photo) => photo.file);
    })
    .immediate();
  deps.photos.removeAfterCommit(files);
  checkpointAfterDelete(deps);
}

/**
 * At start: removes photo files a crash or a failed delete left behind, that is temporary files
 * and photo files no `photos` row names (AC-015.2: nothing of a deleted photo stays on disk).
 */
export function sweepOrphanPhotos(deps: Pick<LedgerDeps, "db" | "photos">): number {
  const known = new Set(
    deps.db
      .prepare<[], { file: string }>("SELECT file FROM photos")
      .all()
      .map((row) => row.file),
  );
  return deps.photos.sweep(known);
}
