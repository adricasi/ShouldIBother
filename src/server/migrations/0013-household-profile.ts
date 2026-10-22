import type { Migration } from "../db.js";

/**
 * Migration 0013 (T-025, REQ-024, AC-024.1, AC-024.2): what the person said in onboarding, kept in
 * the database inside the household-private data folder, never in a tracked file (NFR-002). At
 * most one row. `completed` carries the answers as JSON (outdoor items, dryer, AC and heater use,
 * location); `skipped` carries none, and the baseline in `config/household.json` stays in force.
 * No row means onboarding was never answered. The savings snapshot on each bet is untouched: a
 * changed profile affects only the bets placed afterwards.
 *
 * Also `cards.location_lat` / `location_lon` (AC-014.1): the rounded location a card was made
 * under, written once when the flag `onboarding` is on. Settlement and the rescue check ask for
 * the weather of that place, so a bet is judged where it was priced even if the household moves
 * afterwards. Null on every older card and while the flag is off: the current location applies.
 */
export const householdProfile: Migration = {
  id: 13,
  name: "household_profile",
  sql: `
CREATE TABLE household_profile (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  status     TEXT    NOT NULL CHECK (status IN ('completed', 'skipped')),
  profile    TEXT,
  updated_at INTEGER NOT NULL,
  CHECK ((status = 'completed') = (profile IS NOT NULL))
);

ALTER TABLE cards ADD COLUMN location_lat REAL;
ALTER TABLE cards ADD COLUMN location_lon REAL;

CREATE TRIGGER cards_write_once_location
BEFORE UPDATE OF location_lat, location_lon ON cards
WHEN OLD.location_lat IS NOT NULL OR OLD.location_lon IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cards: location cannot be updated once written');
END;
`,
};
