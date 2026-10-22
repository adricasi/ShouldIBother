import type { Migration } from "../db.js";

/**
 * Migration 0013 (T-025, REQ-024, AC-024.1, AC-024.2): what the person said in onboarding, kept in
 * the database inside the household-private data folder, never in a tracked file (NFR-002). At
 * most one row. `completed` carries the answers as JSON (outdoor items, dryer, AC and heater use,
 * location); `skipped` carries none, and the baseline in `config/household.json` stays in force.
 * No row means onboarding was never answered. The savings snapshot on each bet is untouched: a
 * changed profile affects only the bets placed afterwards.
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
`,
};
