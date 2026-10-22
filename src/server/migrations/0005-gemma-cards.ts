import type { Migration } from "../db.js";

/**
 * Migration 0005 (T-006, REQ-003, REQ-013, NFR-003): where a weather card stands with Gemma.
 * The state is stored on the card so it survives a restart: `thinking` while the bookmaker job
 * runs, `answered` once Gemma's quote replaced the rule's, `question` while Gemma waits for a
 * yes/no tap, `offline` after a failure (Retry is offered, betting stays possible). On start the
 * server turns every `thinking` card into `offline`, because the job died with the process.
 *
 * Adds columns only: existing cards keep their rows and read as NULL, which the app shows as
 * "Gemma offline · rule odds" with Retry. `gemma_answers` is the JSON list of the questions
 * Gemma asked and the taps that answered them, sent to the bookmaker again on the next run.
 */
export const gemmaCards: Migration = {
  id: 5,
  name: "gemma_cards",
  sql: `
ALTER TABLE cards ADD COLUMN gemma_state TEXT
  CHECK (gemma_state IN ('thinking', 'answered', 'question', 'offline'));
ALTER TABLE cards ADD COLUMN gemma_failure TEXT;
ALTER TABLE cards ADD COLUMN gemma_question TEXT;
ALTER TABLE cards ADD COLUMN gemma_answers TEXT NOT NULL DEFAULT '[]';
`,
};
