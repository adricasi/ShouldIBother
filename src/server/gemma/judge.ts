import { z } from "zod";

import type { ChoreSpec } from "../../domain/chores.js";
import type { DoNothingVerdict } from "../../domain/points.js";

import { loadPrompt } from "./prompts.js";
import type { JobFailure, JobRunner } from "./runner.js";
import { untrustedBlock } from "./untrusted.js";

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
  readonly betId?: number;
  readonly cardId?: number;
}

interface JudgeFacts {
  readonly raw: string | undefined;
  readonly model: string;
  readonly modelDigest: string | undefined;
  readonly latencyMs: number;
  /** The `gemma_decisions` row the runner wrote for this job. */
  readonly decisionId: number;
}

export type JudgeResult =
  | (JudgeFacts & {
      readonly ok: true;
      readonly verdict: DoNothingVerdict;
      readonly reason: string;
      readonly evidence: readonly string[];
      readonly raw: string;
    })
  | (JudgeFacts & {
      readonly ok: false;
      readonly failure: JobFailure | "unsure";
      readonly error: string;
    });

/** The data block the prompt calls untrusted: only enums and fixed chore text go in. */
function userMessage(input: JudgeInput): string {
  return untrustedBlock({
    chore: input.chore.judgeName,
    odds_that_doing_nothing_works_pct: input.odds,
    evidence_kind: "one tap",
    person_answered: input.chore.tapAnswers.find((answer) => answer.id === input.answerId)?.label,
    recorded_weather: null,
  });
}

/**
 * Asks the judge for a verdict on a do-nothing bet settled by one tap, through the job runner
 * (queue, deadline, retry once with the validation error, decision log). A failure never
 * produces a verdict: the caller keeps the bet waiting (AC-008.8).
 */
export async function judgeBet(runner: JobRunner, input: JudgeInput): Promise<JudgeResult> {
  const result = await runner.run({
    job: "judge",
    prompt: JUDGE_PROMPT,
    user: userMessage(input),
    schema: judgeOutputSchema,
    check: (output) =>
      output.status === "ok" && output.verdict === undefined
        ? 'status "ok" needs a verdict'
        : undefined,
    ...(input.betId === undefined ? {} : { betId: input.betId }),
    ...(input.cardId === undefined ? {} : { cardId: input.cardId }),
    inputSummary: `${input.chore.judgeName} bet at ${input.odds}%, answer ${input.answerId}`,
  });
  const facts: JudgeFacts = {
    raw: result.raw,
    model: result.model,
    modelDigest: result.modelDigest,
    latencyMs: result.latencyMs,
    decisionId: result.decisionId,
  };
  if (!result.ok) {
    return { ...facts, ok: false, failure: result.failure, error: result.error };
  }
  const { output } = result;
  if (output.status === "unsure" || output.verdict === undefined) {
    return { ...facts, ok: false, failure: "unsure", error: output.question ?? "unsure" };
  }
  return {
    ...facts,
    ok: true,
    verdict: output.verdict,
    reason: output.reason,
    evidence: output.evidence,
    raw: result.raw,
  };
}
