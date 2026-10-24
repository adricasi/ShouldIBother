import type { Migration } from "../db.js";

/**
 * Migration 0019 (T-040, REQ-032): hosted mode's daily model-call counter (AC-032.5).
 *
 * - `model_calls`: one row per Madrid date (`YYYY-MM-DD`) with the chat-completions requests sent
 *   to the inference API that day (`calls`, retries and tool rounds included) and how many of them
 *   were judge verdicts (`judge_calls`, the share the last 20 % of the cap is reserved for). It
 *   survives a restart, so the cap cannot be reset by restarting the app.
 *
 * A table of its own, ADD-only: nothing existing is touched, and home mode never writes to it.
 * The rows hold counts only, no content.
 */
export const modelCalls: Migration = {
  id: 19,
  name: "model_calls",
  sql: `
CREATE TABLE model_calls (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
  judge_calls INTEGER NOT NULL DEFAULT 0 CHECK (judge_calls >= 0)
);
`,
};
