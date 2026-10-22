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
  readonly createdAt: number;
}

/** Records one Gemma job in `gemma_decisions` for the evaluation (REQ-028); returns its id. */
export function logDecision(db: Db, input: DecisionInput): number {
  const result = db
    .prepare(
      `INSERT INTO gemma_decisions (job, card_id, bet_id, photo_id, model, model_digest,
         prompt_version, tool_mode, input_summary, output, valid, retries, latency_ms, error,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.job,
      input.cardId,
      input.betId,
      input.photoId ?? null,
      input.model,
      input.modelDigest ?? null,
      input.promptVersion,
      input.toolMode ?? null,
      input.inputSummary,
      input.output ?? null,
      input.valid ? 1 : 0,
      input.retries,
      input.latencyMs,
      input.error ?? null,
      input.createdAt,
    );
  return Number(result.lastInsertRowid);
}
