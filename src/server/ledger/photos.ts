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

function cardOf(db: Db, cardId: number): CardRow {
  const card = db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  return card;
}

/** The card's current before photo, if one was added (the latest wins). */
export function latestBeforePhoto(db: Db, cardId: number): PhotoRow | undefined {
  return db
    .prepare<[number], PhotoRow>(
      "SELECT * FROM photos WHERE card_id = ? AND role = 'before' ORDER BY received_at DESC, rowid DESC LIMIT 1",
    )
    .get(cardId);
}

/**
 * Stores a before photo for a card (REQ-005): strips metadata and shrinks it first (AC-005.1),
 * and only then writes the row. A file that cannot be decoded is refused with 415 and leaves the
 * card, its quotes and the photo folder exactly as they were (AC-005.6).
 */
export async function addBeforePhoto(
  deps: Pick<LedgerDeps, "db" | "now" | "photos">,
  cardId: number,
  bytes: Buffer,
): Promise<{ card: CardRow; photo: PhotoRow }> {
  const card = cardOf(deps.db, cardId);
  if (card.kind !== "weather") {
    throw new HttpError(409, "No photo on this card", "Only a card with odds takes a photo.");
  }
  const bet = deps.db
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
  let stored;
  try {
    stored = await deps.photos.save(bytes);
  } catch (error) {
    throw error instanceof UnsupportedPhotoError ? unsupportedPhoto() : error;
  }
  try {
    deps.db
      .prepare(
        `INSERT INTO photos (id, card_id, bet_id, role, file, received_at, width, height)
         VALUES (?, ?, NULL, 'before', ?, ?, ?, ?)`,
      )
      .run(stored.id, cardId, stored.file, deps.now(), stored.width, stored.height);
  } catch (error) {
    // No row: do not leave a file nothing points to.
    deps.photos.remove(stored.file);
    throw error;
  }
  const photo = deps.db
    .prepare<[string], PhotoRow>("SELECT * FROM photos WHERE id = ?")
    .get(stored.id)!;
  return { card, photo };
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
 * behind (AC-015.2). Returns false when a reader (the CLI) kept the checkpoint from finishing.
 */
export function checkpointAfterDelete(db: Db): boolean {
  const [result] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
  return result === undefined || result.busy === 0;
}

/**
 * Deletes one photo and everything derived from it (AC-015.2): the file, the `photos` row, the
 * quotes made with it, and every Gemma decision that used it (the inspector's, the judge's, and
 * the bookmaker run that read the inspector's observations). The file goes first: if it cannot
 * be removed the rows stay and the delete can be repeated; a file that is already gone is fine.
 */
export function deletePhoto(deps: Pick<LedgerDeps, "db" | "photos">, id: string): void {
  const photo = getPhotoRow(deps.db, id);
  deps.photos.remove(photo.file);
  deps.db.transaction(() => {
    deleteDerivedOfPhotos(deps.db, [photo.id]);
    deps.db.prepare("DELETE FROM photos WHERE id = ?").run(photo.id);
  })();
  checkpointAfterDelete(deps.db);
}

function deleteDerivedOfPhotos(db: Db, photoIds: readonly string[]): void {
  const markFor = (ids: readonly unknown[]): string => ids.map(() => "?").join(", ");
  if (photoIds.length === 0) {
    return;
  }
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
  for (const decisionId of quoteDecisions) {
    db.prepare("DELETE FROM gemma_decisions WHERE id = ?").run(decisionId);
  }
}

/**
 * Deletes a bet's data (AC-015.2): the bet, its settlements, the card's quotes and decisions, and
 * every photo of the bet or its card, files included. The card is household text too, so it goes
 * with them; the exception is an undone bet on a card that has a newer active bet, where only the
 * undone bet's own rows go and the card stays.
 */
export function deleteBetData(deps: Pick<LedgerDeps, "db" | "photos">, betId: number): void {
  const bet = deps.db
    .prepare<[number], { id: number; card_id: number }>("SELECT id, card_id FROM bets WHERE id = ?")
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
  for (const photo of photos) {
    deps.photos.remove(photo.file);
  }
  deps.db.transaction(() => {
    if (otherActive === undefined) {
      // Cascades: bets, settlements, quotes, photos rows and decisions (migration 0002).
      deps.db.prepare("DELETE FROM cards WHERE id = ?").run(bet.card_id);
    } else {
      deps.db.prepare("DELETE FROM gemma_decisions WHERE bet_id = ?").run(bet.id);
      deps.db.prepare("DELETE FROM bets WHERE id = ?").run(bet.id);
    }
  })();
  checkpointAfterDelete(deps.db);
}
