import type { Db } from "../db.js";

export interface DecisionInput {
  readonly job: string;
  readonly cardId: number | null;
  readonly betId: number | null;
  readonly photoId?: string | null;
  readonly model: string;
  readonly modelDigest: string | undefined;
  readonly promptVersion: string;
  /** Jobs with a tool: whether Gemma called it, the app injected the result, or it was missed. */
  readonly toolMode?: "called" | "injected" | "missed" | undefined;
  /** Short, free of household text and photo data (NFR-007). */
  readonly inputSummary: string;
  readonly output: string | undefined;
  readonly valid: boolean;
  readonly retries: number;
  readonly latencyMs: number;
  readonly error: string | undefined;
  /** The hours `get_forecast` returned to Gemma, compact JSON (migration 0016); public weather only. */
  readonly toolResult?: string | undefined;
  readonly createdAt: number;
}

/**
 * Records one Gemma job in `gemma_decisions` for the evaluation (REQ-028); returns its id.
 * Evaluation queries (calibration, tool-call miss rate, valid-JSON rate) must exclude decisions
 * made by the fake model: `WHERE model NOT LIKE 'fake%'` (the fixtures say `fake-gemma`).
 */
export function logDecision(db: Db, input: DecisionInput): number {
  // A photo deleted while its job ran has no row to point at (and AC-015.2 says nothing derived
  // from it may stay): the decision is logged without the photo id and without what Gemma said.
  const photoGone =
    input.photoId !== undefined &&
    input.photoId !== null &&
    db.prepare("SELECT 1 FROM photos WHERE id = ?").get(input.photoId) === undefined;
  const result = db
    .prepare(
      `INSERT INTO gemma_decisions (job, card_id, bet_id, photo_id, model, model_digest,
         prompt_version, tool_mode, input_summary, output, valid, retries, latency_ms, error,
         tool_result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.job,
      input.cardId,
      input.betId,
      photoGone ? null : (input.photoId ?? null),
      input.model,
      input.modelDigest ?? null,
      input.promptVersion,
      input.toolMode ?? null,
      input.inputSummary,
      photoGone ? null : (input.output ?? null),
      input.valid ? 1 : 0,
      input.retries,
      input.latencyMs,
      photoGone ? "the photo was deleted while the job ran" : (input.error ?? null),
      input.toolResult ?? null,
      input.createdAt,
    );
  return Number(result.lastInsertRowid);
}
