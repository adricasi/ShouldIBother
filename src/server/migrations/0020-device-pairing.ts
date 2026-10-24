import type { Migration } from "../db.js";

/**
 * Migration 0020 (T-040, REQ-032, AC-032.3): linked devices you can tell apart, and a link that
 * stays good for fewer devices.
 *
 * - `pairing.max_sessions`: how many devices one pairing link can link (1 to 3). Existing and home
 *   links keep 3; hosted mode's `sib pair` makes links for one device unless told otherwise.
 * - `sessions.device`: a short summary of the device at pairing ("iPhone · Safari"), for
 *   `sib devices`. It is derived from the user agent and never holds the raw string. Null for
 *   sessions made before this migration.
 *
 * Two ADD COLUMNs: nothing existing is rewritten.
 */
export const devicePairing: Migration = {
  id: 20,
  name: "device_pairing",
  sql: `
ALTER TABLE pairing ADD COLUMN max_sessions INTEGER NOT NULL DEFAULT 3
  CHECK (max_sessions BETWEEN 1 AND 3);
ALTER TABLE sessions ADD COLUMN device TEXT;
`,
};
