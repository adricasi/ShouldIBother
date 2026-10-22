import type { Db } from "../db.js";

import { findHashConstantTime, generateSecret, hashSecret, isWellFormedSecret } from "./secrets.js";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DEVICES_PER_TOKEN = 3;
/** `last_seen_at` is a hint for the owner, so it is refreshed at most this often (one write per minute). */
const LAST_SEEN_GRANULARITY_MS = 60 * 1000;

export interface IssuedToken {
  readonly token: string;
  readonly expiresAt: number;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly expiresAt: number;
}

interface HashRow {
  id: number;
  hash: string;
}

/**
 * Pairing tokens and sessions in SQLite (migration 0001). Raw secrets exist only in the
 * returned values: the database holds SHA-256 hashes. `now` is injected so tests control time.
 */
export class AuthStore {
  private readonly activeTokens;
  private readonly activeSessions;
  private readonly revokeTokens;
  private readonly insertToken;
  private readonly claimSlot;
  private readonly insertSession;
  private readonly touchSession;
  private readonly revokeAllSessions;
  private readonly pruneSessions;
  private readonly pruneTokens;

  constructor(
    private readonly db: Db,
    /** The one clock of the access control; the app takes it from here. */
    readonly now: () => number,
  ) {
    this.activeTokens = db.prepare<[number], HashRow>(
      "SELECT id, token_hash AS hash FROM pairing WHERE revoked_at IS NULL AND expires_at > ?",
    );
    this.activeSessions = db.prepare<[number], HashRow>(
      "SELECT rowid AS id, id_hash AS hash FROM sessions WHERE revoked_at IS NULL AND expires_at > ?",
    );
    this.revokeTokens = db.prepare<[number]>(
      "UPDATE pairing SET revoked_at = ? WHERE revoked_at IS NULL",
    );
    this.insertToken = db.prepare<[string, number, number]>(
      "INSERT INTO pairing (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
    );
    this.claimSlot = db.prepare<[number, number, number]>(
      `UPDATE pairing SET sessions_created = sessions_created + 1
       WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND sessions_created < ?`,
    );
    this.insertSession = db.prepare<[string, number, number, number]>(
      "INSERT INTO sessions (id_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)",
    );
    this.touchSession = db.prepare<[number, number, number]>(
      "UPDATE sessions SET last_seen_at = ? WHERE rowid = ? AND last_seen_at < ?",
    );
    this.revokeAllSessions = db.prepare<[number]>(
      "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL",
    );
    this.pruneSessions = db.prepare<[number]>(
      "DELETE FROM sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?",
    );
    this.pruneTokens = db.prepare<[number]>(
      "DELETE FROM pairing WHERE revoked_at IS NOT NULL OR expires_at <= ?",
    );
  }

  /**
   * A new 10-minute token (AC-001.1). Older unexpired tokens are superseded so only one is ever
   * live; existing sessions are untouched. Expired and revoked rows are deleted here.
   */
  issuePairingToken(): IssuedToken {
    const now = this.now();
    const token = generateSecret();
    const expiresAt = now + PAIRING_TTL_MS;
    this.db
      .transaction(() => {
        this.pruneSessions.run(now);
        this.pruneTokens.run(now);
        this.revokeTokens.run(now);
        this.insertToken.run(hashSecret(token), now, expiresAt);
      })
      .immediate();
    return { token, expiresAt };
  }

  /**
   * Exchanges a token for a session (AC-001.2). Returns null for every failure (unknown,
   * expired, revoked, malformed, or already used by 3 devices) so callers cannot tell them apart.
   */
  pair(token: string): IssuedSession | null {
    if (!isWellFormedSecret(token)) {
      return null;
    }
    const wanted = hashSecret(token);
    return this.db
      .transaction((): IssuedSession | null => {
        const now = this.now();
        const rows = this.activeTokens.all(now);
        const index = findHashConstantTime(
          rows.map((row) => row.hash),
          wanted,
        );
        const row = rows[index];
        if (row === undefined) {
          return null;
        }
        if (this.claimSlot.run(row.id, now, MAX_DEVICES_PER_TOKEN).changes !== 1) {
          return null;
        }
        const sessionId = generateSecret();
        const expiresAt = now + SESSION_TTL_MS;
        this.insertSession.run(hashSecret(sessionId), now, expiresAt, now);
        return { sessionId, expiresAt };
      })
      .immediate();
  }

  /** True when `sessionId` belongs to a live session (AC-001.3, AC-001.8). */
  isValidSession(sessionId: string): boolean {
    if (!isWellFormedSecret(sessionId)) {
      return false;
    }
    const now = this.now();
    const rows = this.activeSessions.all(now);
    const index = findHashConstantTime(
      rows.map((row) => row.hash),
      hashSecret(sessionId),
    );
    const row = rows[index];
    if (row === undefined) {
      return false;
    }
    this.touchSession.run(now, row.id, now - LAST_SEEN_GRANULARITY_MS);
    return true;
  }

  /** Revokes every session and every unexpired token (AC-001.6). */
  forgetDevices(): void {
    const now = this.now();
    this.db
      .transaction(() => {
        this.revokeAllSessions.run(now);
        this.revokeTokens.run(now);
      })
      .immediate();
  }
}
