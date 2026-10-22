import { z } from "zod";

import type { BetChoreSpec } from "../../domain/chores.js";
import type { Verdict } from "../../domain/points.js";
import { RECORDED_WEATHER_LABEL, type WeatherDigest } from "../../domain/weather-digest.js";

import { loadPrompt } from "./prompts.js";
import type { JobFailure, JobRunner } from "./runner.js";
import { untrustedBlock } from "./untrusted.js";

export const JUDGE_PROMPT = loadPrompt("judge", 2);
/** The prompt of an appeal (REQ-023): the same job and schema, told that this is a second look. */
export const APPEAL_PROMPT = loadPrompt("judge-appeal", 1);

const DO_NOTHING_VERDICTS = ["win", "small_loss", "normal_loss", "harmful_loss"] as const;
const DO_IT_VERDICTS = ["weather_would_have", "weather_would_not"] as const;

/** Output of the judge (design.md, Gemma jobs): a verdict for the bet's kind, or a question. */
export const judgeOutputSchema = z
  .object({
    status: z.enum(["ok", "unsure"]),
    verdict: z.enum([...DO_NOTHING_VERDICTS, ...DO_IT_VERDICTS]).optional(),
    // The prompt asks for at most 140 characters and three phrases: the schema holds the same.
    reason: z.string().max(140),
    evidence: z.array(z.string().max(120)).max(3).default([]),
    question: z.string().max(200).optional(),
  })
  .strict();

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

/** How the outcome of the bet is known (AC-008.2, AC-008.3, AC-008.7, AC-008.9). */
export type JudgeEvidence =
  | { readonly kind: "tap"; readonly answerId: string }
  | {
      readonly kind: "photo";
      /** The before photo of the card, when it has one. */
      readonly before?: Uint8Array;
      readonly after: Uint8Array;
    }
  /** Nobody answered (24 h passed), or a do-it decision: the recorded weather alone. */
  | { readonly kind: "weather" };

export interface JudgeFollowup {
  readonly question: string;
  readonly yes: boolean;
}

/** The verdict an appeal disputes: what the first judgement said and how it knew (REQ-023). */
export interface JudgeAppeal {
  readonly firstVerdict: Verdict;
  /** The first judgement's reason; null once its decision was deleted (AC-015.2). */
  readonly firstReason: string | null;
  readonly firstEvidence: JudgeEvidence["kind"];
}

export interface JudgeInput {
  readonly chore: BetChoreSpec;
  readonly kind: "do_nothing" | "do_it";
  readonly odds: number;
  readonly evidence: JudgeEvidence;
  readonly weather: WeatherDigest | null;
  /** Questions Gemma asked before and the taps that answered them (AC-008.5). */
  readonly followups: readonly JudgeFollowup[];
  /** False when no one can answer a question (weather only) or enough rounds were asked. */
  readonly canAsk: boolean;
  readonly betId?: number;
  readonly cardId?: number;
  /** The after photo's id, so deleting the photo deletes this decision (AC-015.2). */
  readonly photoId?: string;
  /** Set when the person appeals a settled bet with a new photo: the evidence is that photo. */
  readonly appeal?: JudgeAppeal;
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
      readonly verdict: Verdict;
      readonly reason: string;
      readonly evidence: readonly string[];
      readonly raw: string;
    })
  | (JudgeFacts & {
      readonly ok: false;
      readonly failure: JobFailure | "unsure";
      readonly error: string;
      /** The yes/no question when the judge was unsure (AC-008.5). */
      readonly question?: string;
    });

/** What the check says to a judge that was unsure when it may not ask (also how the log spots it). */
export const CANNOT_ASK_MESSAGE = "you cannot ask a question now";

const EVIDENCE_TEXT = {
  tap: "one tap",
  photo: "after photo",
  weather: "weather record only",
} as const;

/** The data block the prompt calls untrusted: enums, fixed chore text, numbers and the tap label. */
function userMessage(input: JudgeInput): string {
  const { evidence } = input;
  return untrustedBlock({
    bet: input.kind,
    chore: input.chore.judgeName,
    evidence: EVIDENCE_TEXT[evidence.kind],
    person_answered:
      evidence.kind === "tap"
        ? input.chore.tapAnswers.find((answer) => answer.id === evidence.answerId)?.label
        : undefined,
    photos:
      evidence.kind === "photo"
        ? evidence.before === undefined
          ? ["after"]
          : ["before", "after"]
        : [],
    recorded_weather:
      input.weather === null ? null : { label: RECORDED_WEATHER_LABEL, ...input.weather },
    earlier_questions: input.followups.map((followup) => ({
      question: followup.question,
      answer: followup.yes ? "yes" : "no",
    })),
    can_ask: input.canAsk,
    appeal:
      input.appeal === undefined
        ? undefined
        : {
            first_verdict: input.appeal.firstVerdict,
            first_reason: input.appeal.firstReason,
            first_evidence: EVIDENCE_TEXT[input.appeal.firstEvidence],
          },
  });
}

function summary(input: JudgeInput): string {
  const { evidence } = input;
  const how =
    evidence.kind === "tap"
      ? `tap ${evidence.answerId}`
      : evidence.kind === "photo"
        ? `photo${evidence.before === undefined ? "" : " with before"}`
        : "weather only";
  const appeal = input.appeal === undefined ? "" : ` appeal of ${input.appeal.firstVerdict},`;
  return `${input.chore.judgeName} ${input.kind} at ${input.odds}%,${appeal} ${how}, ${input.followups.length} follow-ups`;
}

function allowedVerdicts(kind: JudgeInput["kind"]): readonly Verdict[] {
  return kind === "do_it" ? DO_IT_VERDICTS : DO_NOTHING_VERDICTS;
}

/**
 * Asks the judge for a verdict through the job runner (queue, deadline, retry once with the
 * validation error, decision log). A failure never produces a verdict: the caller keeps the bet
 * waiting for Gemma (AC-008.8). `JobQueueFullError` is thrown through; the caller answers "busy".
 */
export async function judgeBet(runner: JobRunner, input: JudgeInput): Promise<JudgeResult> {
  const images =
    input.evidence.kind === "photo"
      ? [
          ...(input.evidence.before === undefined ? [] : [input.evidence.before]),
          input.evidence.after,
        ]
      : undefined;
  const allowed = allowedVerdicts(input.kind);
  const result = await runner.run({
    job: "judge",
    prompt: input.appeal === undefined ? JUDGE_PROMPT : APPEAL_PROMPT,
    user: userMessage(input),
    ...(images === undefined ? {} : { images }),
    schema: judgeOutputSchema,
    check: (output) => {
      if (output.status === "ok") {
        if (output.verdict === undefined) {
          return 'status "ok" needs a verdict';
        }
        return allowed.includes(output.verdict)
          ? undefined
          : `for a bet of kind "${input.kind}" the verdict must be one of ${allowed.join(", ")}`;
      }
      if (!input.canAsk) {
        return `${CANNOT_ASK_MESSAGE}: answer with status "ok" and a verdict`;
      }
      return (output.question ?? "").trim() === ""
        ? 'status "unsure" needs a yes/no question'
        : undefined;
    },
    ...(input.betId === undefined ? {} : { betId: input.betId }),
    ...(input.cardId === undefined ? {} : { cardId: input.cardId }),
    ...(input.photoId === undefined ? {} : { photoId: input.photoId }),
    inputSummary: summary(input),
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
    return {
      ...facts,
      ok: false,
      failure: "unsure",
      error: output.question ?? "unsure",
      ...(output.question === undefined ? {} : { question: output.question.trim() }),
    };
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
