import type { Db } from "../db.js";

/** The most forecast hours a decision keeps (migration 0016); the log enforces it, not only the tool. */
export const MAX_TOOL_RESULT_HOURS = 24;

/**
 * The tool result as it is stored: a JSON list of at most 24 rows. Anything else (not JSON, not a
 * list) is dropped rather than stored, so a caller's mistake cannot put free text in the log.
 */
export function boundToolResult(
  text: string | undefined,
  maxRows: number = MAX_TOOL_RESULT_HOURS,
): string | null {
  if (text === undefined) {
    return null;
  }
  try {
    const rows = JSON.parse(text) as unknown;
    return Array.isArray(rows) ? JSON.stringify(rows.slice(0, maxRows)) : null;
  } catch {
    return null;
  }
}

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
  /** Rows of the tool result to keep: 24 unless the job's tool says more (the advisor, 72). */
  readonly toolResultRows?: number | undefined;
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
      boundToolResult(input.toolResult, input.toolResultRows),
      input.createdAt,
    );
  return Number(result.lastInsertRowid);
}
