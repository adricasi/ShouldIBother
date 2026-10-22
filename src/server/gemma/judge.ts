import { z } from "zod";

import type { ChoreSpec } from "../../domain/chores.js";
import type { DoNothingVerdict } from "../../domain/points.js";
import {
  ModelTimeoutError,
  ModelUnavailableError,
  type ChatRequest,
  type ModelClient,
} from "../model/client.js";

import { loadPrompt } from "./prompts.js";

/** 30 s per model call (requirements.md, fixed values). */
export const MODEL_CALL_TIMEOUT_MS = 30_000;

export const JUDGE_PROMPT = loadPrompt("judge", 1);

const verdictSchema = z.enum(["win", "small_loss", "normal_loss", "harmful_loss"]);

/** Output of the judge for a do-nothing bet (design.md, Gemma jobs). */
export const judgeOutputSchema = z
  .object({
    status: z.enum(["ok", "unsure"]),
    verdict: verdictSchema.optional(),
    reason: z.string().max(200),
    evidence: z.array(z.string().max(120)).max(5).default([]),
    question: z.string().max(200).optional(),
  })
  .strict();

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export interface JudgeInput {
  readonly chore: ChoreSpec;
  readonly odds: number;
  /** Id of the tapped answer; one of the chore's `tapAnswers`. */
  readonly answerId: string;
}

export type JudgeResult =
  | {
      readonly ok: true;
      readonly verdict: DoNothingVerdict;
      readonly reason: string;
      readonly evidence: readonly string[];
      readonly raw: string;
      readonly model: string;
      readonly modelDigest: string | undefined;
      readonly latencyMs: number;
    }
  | {
      readonly ok: false;
      readonly failure: "unavailable" | "timeout" | "invalid" | "unsure";
      readonly error: string;
      readonly raw: string | undefined;
      readonly model: string;
      readonly modelDigest: string | undefined;
      readonly latencyMs: number;
    };

/** The data block the prompt calls untrusted: only enums and fixed chore text go in. */
function userMessage(input: JudgeInput): string {
  const data = {
    chore: input.chore.judgeName,
    odds_that_doing_nothing_works_pct: input.odds,
    evidence_kind: "one tap",
    person_answered: input.chore.tapAnswers.find((answer) => answer.id === input.answerId)?.label,
    recorded_weather: null,
  };
  return `<untrusted_data>\n${JSON.stringify(data)}\n</untrusted_data>`;
}

/**
 * Asks the judge for a verdict on a do-nothing bet settled by one tap. One call, validated with
 * the schema; the retry budget, tool loop and deadline of the job runner arrive with T-006 and
 * T-009. A failure never produces a verdict: the caller keeps the bet waiting (AC-008.8).
 */
export async function judgeBet(model: ModelClient, input: JudgeInput): Promise<JudgeResult> {
  const request: ChatRequest = {
    job: "judge",
    messages: [
      { role: "system", content: JUDGE_PROMPT.text },
      { role: "user", content: userMessage(input) },
    ],
    schema: z.toJSONSchema(judgeOutputSchema),
    timeoutMs: MODEL_CALL_TIMEOUT_MS,
  };
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);

  let response;
  try {
    response = await model.chat(request);
  } catch (error) {
    if (error instanceof ModelTimeoutError || error instanceof ModelUnavailableError) {
      return {
        ok: false,
        failure: error instanceof ModelTimeoutError ? "timeout" : "unavailable",
        error: error.message,
        raw: undefined,
        model: "unknown",
        modelDigest: undefined,
        latencyMs: elapsed(),
      };
    }
    throw error;
  }

  const base = { model: response.model, modelDigest: response.modelDigest, latencyMs: elapsed() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    return {
      ok: false,
      failure: "invalid",
      error: "Answer is not JSON",
      raw: response.content,
      ...base,
    };
  }
  const result = judgeOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      failure: "invalid",
      error: result.error.message,
      raw: response.content,
      ...base,
    };
  }
  const output = result.data;
  if (output.status === "unsure") {
    return {
      ok: false,
      failure: "unsure",
      error: output.question ?? "unsure",
      raw: response.content,
      ...base,
    };
  }
  if (output.verdict === undefined) {
    return {
      ok: false,
      failure: "invalid",
      error: "Missing verdict",
      raw: response.content,
      ...base,
    };
  }
  return {
    ok: true,
    verdict: output.verdict,
    reason: output.reason,
    evidence: output.evidence,
    raw: response.content,
    ...base,
  };
}
