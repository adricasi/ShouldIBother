import type { Migration } from "../db.js";

/**
 * Migration 0001 (T-003, REQ-001): pairing tokens and sessions. Only SHA-256 hashes are
 * stored; times are epoch milliseconds.
 */
export const pairingSessions: Migration = {
  id: 1,
  name: "pairing_sessions",
  sql: `
CREATE TABLE pairing (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash       TEXT    NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  sessions_created INTEGER NOT NULL DEFAULT 0 CHECK (sessions_created BETWEEN 0 AND 3)
);

CREATE TABLE sessions (
  id_hash      TEXT    PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at   INTEGER
);
`,
};
