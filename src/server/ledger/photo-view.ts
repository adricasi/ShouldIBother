import { nameOfBand, type BandTable } from "../../domain/bands.js";
import {
  inspectorOutputSchema,
  OBSERVATION_LABELS,
  type InspectorOutput,
  type Observation,
} from "../gemma/inspector.js";
import type { Db } from "../db.js";

import { FAILURE_NOTES } from "./views.js";
import type { PhotoRow } from "./photos.js";
import type { CardRow, QuoteRow } from "./rows.js";

/** The card's current before photo: the latest one (a new photo replaces the old). */
export function currentPhoto(db: Pick<Db, "prepare">, cardId: number): PhotoRow | undefined {
  return db
    .prepare<[number], PhotoRow>(
      "SELECT * FROM photos WHERE card_id = ? AND role = 'before' ORDER BY received_at DESC, rowid DESC LIMIT 1",
    )
    .get(cardId);
}

/** What the inspector made of a photo, read from its logged decision; undefined if it has none. */
export function inspectorRead(
  db: Pick<Db, "prepare">,
  photoId: string,
): InspectorOutput | undefined {
  const row = db
    .prepare<[string], { output: string | null }>(
      `SELECT output FROM gemma_decisions
       WHERE photo_id = ? AND job = 'inspector' AND valid = 1 ORDER BY id DESC LIMIT 1`,
    )
    .get(photoId);
  if (row?.output === null || row === undefined) {
    return undefined;
  }
  try {
    const parsed = inspectorOutputSchema.safeParse(JSON.parse(row.output));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The observations a bookmaker run should read for this card: those of its current photo. */
export function currentObservations(
  db: Pick<Db, "prepare">,
  cardId: number,
): { photoId: string; observations: readonly Observation[] } | undefined {
  const photo = currentPhoto(db, cardId);
  if (photo === undefined) {
    return undefined;
  }
  const read = inspectorRead(db, photo.id);
  return read?.status === "ok" && (read.observations ?? []).length > 0
    ? { photoId: photo.id, observations: read.observations ?? [] }
    : undefined;
}

function percent(odds: number): string {
  return `${odds}%`;
}

/**
 * The photo block of a card (AC-005.3, AC-005.4, AC-028.1): the "What Gemma saw" list, the odds
 * before and after the photo, or Gemma's yes/no question when it could not tell. Null without a
 * before photo.
 */
export function cardPhotoView(db: Pick<Db, "prepare">, card: CardRow, table: BandTable) {
  const photo = currentPhoto(db, card.id);
  if (photo === undefined) {
    return null;
  }
  const state = card.photo_state ?? "seen";
  const read = state === "inspecting" ? undefined : inspectorRead(db, photo.id);
  const after = db
    .prepare<[string], QuoteRow>(
      "SELECT * FROM quotes WHERE photo_id = ? AND with_photo = 1 ORDER BY id DESC LIMIT 1",
    )
    .get(photo.id);
  const before =
    after === undefined
      ? undefined
      : db
          .prepare<[number, number], QuoteRow>(
            "SELECT * FROM quotes WHERE card_id = ? AND with_photo = 0 AND id < ? ORDER BY id DESC LIMIT 1",
          )
          .get(card.id, after.id);
  let note: string | null = null;
  if (state === "inspecting") {
    note = "Gemma is looking at your photo.";
  } else if (state === "unsure") {
    note = "Gemma couldn't tell from this photo, so the odds stay as they were.";
  } else if (state === "failed") {
    note = `${FAILURE_NOTES[card.photo_failure ?? "unavailable"] ?? "Gemma could not read the photo."} The odds stay as they were.`;
  } else if (after === undefined) {
    note =
      card.photo_failure === "odds_kept" || card.photo_failure === null
        ? "Gemma saw this but could not sharpen the odds, so they stay as they were."
        : `${FAILURE_NOTES[card.photo_failure] ?? "Gemma did not answer."} The odds stay as they were.`;
  }
  return {
    id: photo.id,
    url: `/photos/${photo.id}`,
    state,
    /** "What Gemma saw" (AC-005.3, AC-028.1). */
    saw:
      read?.status === "ok"
        ? (read.observations ?? []).map((observation) => ({
            name: observation.name,
            label: OBSERVATION_LABELS[observation.name],
            value: observation.value,
          }))
        : [],
    /** Gemma's yes/no question when the inspector was unsure (AC-005.4). */
    question: read?.status === "unsure" ? (read.question ?? null) : null,
    note,
    /** The odds before and after the photo, e.g. "35% → 50%" (AC-005.3). */
    odds_change:
      after === undefined || before === undefined
        ? null
        : {
            before: before.odds,
            after: after.odds,
            before_band_name: nameOfBand(table, before.band),
            after_band_name: nameOfBand(table, after.band),
            text: `${percent(before.odds)} → ${percent(after.odds)}`,
          },
  };
}

export type CardPhotoView = ReturnType<typeof cardPhotoView>;
