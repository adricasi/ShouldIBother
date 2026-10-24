import type { Migration } from "../db.js";

/**
 * Migration 0015 (T-033, REQ-026, AC-026.3, AC-024.1): the optional place label of onboarding,
 * free text such as "Gràcia · Barcelona", shown in the weather board header. It is stored beside
 * the answers in the household-private data folder and nowhere else: it is not part of the
 * household JSON that the savings, the weather client and the prompts read. Null on every
 * existing row, so nothing changes for a profile saved before. The 40-code-point limit is the
 * validator's; SQLite's `length()` counts characters, so the same limit holds here too.
 */
export const placeLabel: Migration = {
  id: 15,
  name: "place_label",
  sql: `
ALTER TABLE household_profile
  ADD COLUMN place_label TEXT CHECK (place_label IS NULL OR length(place_label) <= 40);
`,
};
