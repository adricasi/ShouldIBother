import type { Migration } from "../db.js";

/**
 * Migration 0011 (T-023, REQ-022): rescue alerts and cash-out, both behind the `rescue` flag.
 *
 * - `rescue_checks`: the latest forecast re-check of an open bet (AC-022.1): when it ran, the
 *   forecast it used, the rule band of the remaining window, and whether the alert is up with
 *   the sentence shown on the slip. One row per bet, replaced by the next check. It is a table of
 *   its own because the `bets` columns are locked (migration 0003).
 * - `cash_outs`: a bet cashed out at -10 points (AC-022.2). `settlements.verdict` has a CHECK
 *   list that cannot be widened without rebuilding that table, and a cash-out has no verdict, no
 *   evidence and no multiplier, so it gets its own row; the points total adds both tables. The
 *   bet's status goes `open → cashed_out`, an arrow migration 0003 already allows.
 *
 * Both tables go with their bet (ON DELETE CASCADE), so deleting a bet's data (AC-015.2) and
 * "delete all" need no extra code. Only new tables: existing rows are untouched.
 */
export const rescue: Migration = {
  id: 11,
  name: "rescue",
  sql: `
CREATE TABLE rescue_checks (
  bet_id      INTEGER PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
  checked_at  INTEGER NOT NULL,
  forecast_at INTEGER NOT NULL,
  rule_band   INTEGER NOT NULL CHECK (rule_band BETWEEN 0 AND 4),
  alert       INTEGER NOT NULL CHECK (alert IN (0, 1)),
  reason      TEXT
);

CREATE TABLE cash_outs (
  bet_id        INTEGER PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
  points        INTEGER NOT NULL,
  cashed_out_at INTEGER NOT NULL,
  alert_showing INTEGER NOT NULL CHECK (alert_showing IN (0, 1))
);
`,
};
