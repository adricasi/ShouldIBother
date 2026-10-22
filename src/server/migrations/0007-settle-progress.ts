import type { Migration } from "../db.js";

/**
 * Migration 0007 (T-009, REQ-008, REQ-011, NFR-003): what a bet knows while it settles.
 *
 * `settle_progress` holds the user's answer (one tap, or an after photo) the moment it is given,
 * before the judge is called, so a judge that is offline or times out loses nothing (AC-008.8).
 * It also holds the judge's open yes/no question and the answers to earlier ones (AC-008.5), the
 * recorded-weather snapshot the person saw on the settle screen (AC-008.1), and when and why the
 * judge was last tried so the scheduler can retry without hammering a Gemma that is down.
 * The row stays after the bet is settled: it names the before and after photo the judge used, so
 * deleting either photo can also delete the judge's decisions (AC-015.2).
 *
 * The after photo's row goes with the photo (a pending answer whose photo was deleted is gone and
 * can be given again); the before photo may go without losing the answer.
 *
 * Adds a table only: the existing bets, settlements and the bet triggers of migration 0003 are
 * untouched, and every status change the settlement needs is already an arrow of the machine.
 */
export const settleProgress: Migration = {
  id: 7,
  name: "settle_progress",
  sql: `
CREATE TABLE settle_progress (
  bet_id          INTEGER PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
  evidence        TEXT    CHECK (evidence IN ('tap', 'photo')),
  answer_id       TEXT,
  photo_id        TEXT    REFERENCES photos(id) ON DELETE CASCADE,
  before_photo_id TEXT    REFERENCES photos(id) ON DELETE SET NULL,
  answered_at     INTEGER,
  question        TEXT,
  followups       TEXT    NOT NULL DEFAULT '[]',
  weather         TEXT,
  tried_at        INTEGER,
  failure         TEXT,
  CHECK (
    (evidence IS NULL AND answer_id IS NULL AND photo_id IS NULL AND answered_at IS NULL)
    OR (evidence = 'tap' AND answer_id IS NOT NULL AND photo_id IS NULL AND answered_at IS NOT NULL)
    OR (evidence = 'photo' AND photo_id IS NOT NULL AND answer_id IS NULL AND answered_at IS NOT NULL)
  )
);
CREATE INDEX settle_progress_photo_id ON settle_progress (photo_id);
CREATE INDEX settle_progress_before_photo_id ON settle_progress (before_photo_id);
`,
};
