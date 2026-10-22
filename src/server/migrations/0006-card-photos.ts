import type { Migration } from "../db.js";

/**
 * Migration 0006 (T-007, REQ-005, NFR-003): where a card's before photo stands with the inspector.
 * `inspecting` while the inspector and the bookmaker work on it, `seen` once the inspector read
 * it, `unsure` when it could not tell (the odds stay as they were), `failed` when a job failed.
 * `photo_failure` is the failure code for `failed` and for a `seen` photo whose odds could not be
 * updated. On start the server turns every `inspecting` card into `failed`, because the job died
 * with the process.
 *
 * Adds columns only: existing cards keep their rows and read as NULL (no photo state).
 * What Gemma saw is not stored here: it is the inspector's decision row, which is deleted with
 * the photo (AC-015.2).
 */
export const cardPhotos: Migration = {
  id: 6,
  name: "card_photos",
  sql: `
ALTER TABLE cards ADD COLUMN photo_state TEXT
  CHECK (photo_state IN ('inspecting', 'seen', 'unsure', 'failed'));
ALTER TABLE cards ADD COLUMN photo_failure TEXT;
`,
};
