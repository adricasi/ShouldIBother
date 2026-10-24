import { z } from "zod";

import {
  ADVICE_CHORES,
  ADVICE_HORIZON_HOURS,
  ADVICE_KINDS,
  adviceContradiction,
  type Advice,
  type AdviceChore,
  type AdviceRules,
} from "../../domain/advice.js";
import { madridParts } from "../../domain/time.js";
import type { ForecastHour } from "../../domain/weather.js";

import {
  ADVISOR_MAX_HOURS_AHEAD,
  createForecastTool,
  type ForecastReader,
} from "./forecast-tool.js";
import { loadPrompt } from "./prompts.js";
import type { JobResult, JobRunner } from "./runner.js";
import { untrustedBlock } from "./untrusted.js";

export const ADVISOR_JOB = "advisor";
export const ADVISOR_PROMPT = loadPrompt(ADVISOR_JOB, 1);

/** The start of the retry message when the forecast contradicts a window (AC-031.2). */
export const ADVISOR_CONTRADICTION_PREFIX = "The forecast contradicts your answer";

/** The reason line is one sentence of at most 140 characters (design.md, Gemma jobs). */
export const MAX_ADVISOR_REASON_CHARS = 140;

const windowSchema = z
  .object({
    start_hours_ahead: z
      .number()
      .int()
      .min(0)
      .max(ADVICE_HORIZON_HOURS - 1),
    end_hours_ahead: z.number().int().min(1).max(ADVICE_HORIZON_HOURS),
  })
  .strict();

/**
 * Output of the advisor (design.md, Advice cards): `{status: ok|unsure, advice: do_now|wait|
 * no_window, window?: {start_hours_ahead, end_hours_ahead}, reason}`. A window counts hours from
 * forecast row 0, the current hour. Only `wait` has one, and it must be a real span inside the 72
 * hours. `unsure` needs nothing else: the card then shows the rule advice.
 */
export const advisorOutputSchema = z
  .object({
    status: z.enum(["ok", "unsure"]),
    advice: z.enum(ADVICE_KINDS).optional(),
    window: windowSchema.optional(),
    reason: z.string().max(MAX_ADVISOR_REASON_CHARS).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const problem = advisorProblem(value);
    if (problem !== undefined) {
      context.addIssue({ code: "custom", message: problem });
    }
  });

export type AdvisorOutput = z.infer<typeof advisorOutputSchema>;

interface RawOutput {
  status: "ok" | "unsure";
  advice?: (typeof ADVICE_KINDS)[number] | undefined;
  window?: { start_hours_ahead: number; end_hours_ahead: number } | undefined;
  reason?: string | undefined;
}

/** Why an answer contradicts itself, or undefined when it holds together. */
function advisorProblem(value: RawOutput): string | undefined {
  if (value.status === "unsure") {
    return value.advice === undefined && value.window === undefined
      ? undefined
      : 'status "unsure" has no "advice" or "window"';
  }
  if (value.advice === undefined || (value.reason ?? "").trim() === "") {
    return 'status "ok" needs "advice" and "reason"';
  }
  if (value.advice === "wait") {
    if (value.window === undefined) {
      return '"wait" needs a "window"';
    }
    return value.window.end_hours_ahead > value.window.start_hours_ahead
      ? undefined
      : 'the "window" must end after it starts';
  }
  return value.window === undefined ? undefined : `"${value.advice}" has no "window"`;
}

/** The advice of an `ok` answer in the domain's shape; undefined for `unsure`. */
export function adviceOf(output: AdvisorOutput): Advice | undefined {
  if (output.status !== "ok" || output.advice === undefined) {
    return undefined;
  }
  return output.window === undefined
    ? { advice: output.advice }
    : {
        advice: output.advice,
        window: {
          startHoursAhead: output.window.start_hours_ahead,
          endHoursAhead: output.window.end_hours_ahead,
        },
      };
}

export interface AdvisorInput {
  readonly chore: AdviceChore;
  /** What the person wrote about the chore; untrusted. */
  readonly label: string;
  readonly nowMs: number;
  /** The forecast from the current hour on: what `get_forecast` serves and the checks read. */
  readonly hours: readonly ForecastHour[];
  /** The advice rules (`config/advice-rules.json`) the contradiction check applies. */
  readonly rules: AdviceRules;
  readonly cardId: number;
  readonly enqueuedAt?: number;
}

function localTime(epochMs: number): string {
  const t = madridParts(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}`;
}

/** The data block of the advisor prompt: the chore and the person's words; the weather comes from the tool. */
export function advisorUserMessage(input: AdvisorInput): string {
  return untrustedBlock({
    task: "advise when to do the chore",
    chore: ADVICE_CHORES[input.chore].action,
    chore_type: input.chore,
    person_wrote: input.label,
    now_europe_madrid: localTime(input.nowMs),
    horizon_hours: ADVICE_HORIZON_HOURS,
  });
}

/**
 * What the forecast rules out, as a message for the retry (AC-031.2): a window with a wet hour in
 * it for the windows, gusts for the sweep, rain or damp for paint, or heavy rain still to come for
 * the lawn.
 */
export function advisorCheck(input: AdvisorInput): (output: AdvisorOutput) => string | undefined {
  return (output) => {
    const advice = adviceOf(output);
    if (advice === undefined) {
      return undefined;
    }
    const problem = adviceContradiction(input.chore, input.hours, advice, input.rules);
    return problem === undefined
      ? undefined
      : `${ADVISOR_CONTRADICTION_PREFIX}: ${problem}. Pick a window whose hours are all fine for the chore, or answer "no_window".`;
  };
}

/** Asks the advisor when to do an outdoor chore (REQ-031); `get_forecast` is required, up to 72 hours. */
export function runAdvisor(
  runner: JobRunner,
  input: AdvisorInput,
  read: ForecastReader,
): Promise<JobResult<AdvisorOutput>> {
  return runner.run({
    job: ADVISOR_JOB,
    prompt: ADVISOR_PROMPT,
    user: advisorUserMessage(input),
    schema: advisorOutputSchema,
    check: advisorCheck(input),
    tool: createForecastTool(read, {
      required: true,
      injectedHoursAhead: ADVISOR_MAX_HOURS_AHEAD,
      maxHoursAhead: ADVISOR_MAX_HOURS_AHEAD,
      keepRows: ADVISOR_MAX_HOURS_AHEAD,
    }),
    cardId: input.cardId,
    // The person's words are household text: only the chore type is stored with the decision.
    inputSummary: `advice card ${input.chore}, ${input.hours.length} forecast hours`,
    ...(input.enqueuedAt === undefined ? {} : { enqueuedAt: input.enqueuedAt }),
  });
}
