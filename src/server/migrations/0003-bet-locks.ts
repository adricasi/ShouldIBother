import type { Migration } from "../db.js";

/**
 * Migration 0003 (T-008, REQ-006, NFR-003): the database itself enforces what the design calls
 * "locked fields never updated after insert" (AC-006.1, AC-006.2) and the bet state machine.
 *
 * - Strictly locked, even for a write of the same value: id, card_id, kind, band, odds,
 *   odds_source, reason, gemma_band, rule_band, placed_at, undo_until, settle_at.
 * - Write-once: savings_snapshot, model_version, prompt_version and band_without_photo may change
 *   once from NULL to a value, then never again. Their tasks (T-006, T-007, T-009) normally write
 *   them at INSERT; the one-time fill lets a bet placed before those tasks existed (the first
 *   real bets) be completed later without being able to be rewritten afterwards.
 * - Only `status` may change besides, and only along the machine's arrows; a settled, undone or
 *   cashed-out bet never changes status again. Deleting rows stays possible (AC-015.2).
 *
 * Adds triggers only: existing rows are untouched. The SQL is written out, not generated from
 * `src/domain/bet-state.ts`, because an applied migration must never change; a test keeps the
 * trigger and the TypeScript table equal. A later task that needs another arrow adds a migration
 * that replaces the trigger.
 */
export const betLocks: Migration = {
  id: 3,
  name: "bet_locks",
  sql: `
CREATE TRIGGER bets_locked_columns
BEFORE UPDATE OF id, card_id, kind, band, odds, odds_source, reason, gemma_band, rule_band,
  placed_at, undo_until, settle_at ON bets
BEGIN
  SELECT RAISE(ABORT, 'bets: the locked columns of a bet cannot be updated');
END;

CREATE TRIGGER bets_write_once_savings_snapshot
BEFORE UPDATE OF savings_snapshot ON bets
WHEN OLD.savings_snapshot IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'bets: the locked columns of a bet cannot be updated (savings_snapshot)');
END;

CREATE TRIGGER bets_write_once_model_version
BEFORE UPDATE OF model_version ON bets
WHEN OLD.model_version IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'bets: the locked columns of a bet cannot be updated (model_version)');
END;

CREATE TRIGGER bets_write_once_prompt_version
BEFORE UPDATE OF prompt_version ON bets
WHEN OLD.prompt_version IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'bets: the locked columns of a bet cannot be updated (prompt_version)');
END;

CREATE TRIGGER bets_write_once_band_without_photo
BEFORE UPDATE OF band_without_photo ON bets
WHEN OLD.band_without_photo IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'bets: the locked columns of a bet cannot be updated (band_without_photo)');
END;

CREATE TRIGGER bets_status_machine
BEFORE UPDATE OF status ON bets
WHEN NEW.status != OLD.status AND NOT (
  (OLD.status = 'open' AND NEW.status IN ('due', 'undone', 'cashed_out'))
  OR (OLD.status = 'due'
      AND NEW.status IN ('awaiting_weather', 'awaiting_gemma', 'settled', 'cashed_out'))
  OR (OLD.status = 'awaiting_weather' AND NEW.status IN ('awaiting_gemma', 'settled'))
  OR (OLD.status = 'awaiting_gemma' AND NEW.status = 'settled')
)
BEGIN
  SELECT RAISE(ABORT, 'bets: this status change is not an arrow of the bet state machine');
END;
`,
};
