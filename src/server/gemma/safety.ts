import { z } from "zod";

import { ADVICE_CHORES, isAdviceChore, type AdviceChore } from "../../domain/advice.js";
import { CHORES, type ChoreType } from "../../domain/chores.js";
import { madridParts } from "../../domain/time.js";
import type { ForecastHour } from "../../domain/weather.js";

import { forecastRows } from "./forecast-tool.js";
import { loadPrompt } from "./prompts.js";
import type { JobResult, JobRunner } from "./runner.js";
import { untrustedBlock } from "./untrusted.js";

export const SAFETY_PROMPT = loadPrompt("safety", 1);

/** The reason on an alert card is one line (design.md, Gemma jobs). */
export const MAX_SAFETY_REASON_CHARS = 140;

/** At most this many forecast hours go to the guard: the longest card window is under 36 h. */
export const MAX_SAFETY_HOURS = 36;

/**
 * Output of the safety guard (design.md, Gemma jobs: `alert: bool; reason?`). `status` adds the
 * `unsure` path every Gemma job has: the guard could not decide, and the card stays as it is. An
 * `ok` answer carries the verdict; an alert needs its reason, which the card shows (AC-012.3).
 */
export const safetyOutputSchema = z
  .object({
    status: z.enum(["ok", "unsure"]),
    alert: z.boolean().optional(),
    reason: z.string().max(MAX_SAFETY_REASON_CHARS).optional(),
    question: z.string().max(200).optional(),
  })
  .strict()
  .refine((value) => value.status !== "ok" || value.alert !== undefined, {
    message: 'status "ok" needs "alert" (true or false)',
  })
  .refine((value) => value.alert !== true || (value.reason ?? "").trim() !== "", {
    message: 'an alert needs a "reason"',
  });

export type SafetyOutput = z.infer<typeof safetyOutputSchema>;

export interface SafetyInput {
  readonly chore: ChoreType | AdviceChore;
  /** What the person wrote about the chore; untrusted. */
  readonly label: string;
  readonly nowMs: number;
  /** The card's rule window: what the forecast rows below cover. */
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly forecast: readonly ForecastHour[];
  readonly cardId: number;
  readonly enqueuedAt?: number;
}

function localTime(epochMs: number): string {
  const t = madridParts(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}`;
}

/** The data block of the safety prompt: the chore, the person's words and the window's forecast. */
export function safetyUserMessage(input: SafetyInput): string {
  return untrustedBlock({
    chore: isAdviceChore(input.chore)
      ? ADVICE_CHORES[input.chore].judgeName
      : CHORES[input.chore].judgeName,
    chore_type: input.chore,
    person_wrote: input.label,
    now_europe_madrid: localTime(input.nowMs),
    window_europe_madrid: {
      from: localTime(input.window.fromMs),
      to: localTime(input.window.toMs),
    },
    forecast: forecastRows(input.forecast.slice(0, MAX_SAFETY_HOURS)),
  });
}

/** Asks the safety guard whether a new card touches safety (REQ-012, AC-012.3). */
export function runSafetyGuard(
  runner: JobRunner,
  input: SafetyInput,
): Promise<JobResult<SafetyOutput>> {
  return runner.run({
    job: "safety",
    prompt: SAFETY_PROMPT,
    user: safetyUserMessage(input),
    schema: safetyOutputSchema,
    cardId: input.cardId,
    // The person's words are household text: only the chore and the window size are stored.
    inputSummary: `${input.chore} card, ${Math.min(input.forecast.length, MAX_SAFETY_HOURS)} forecast hours`,
    ...(input.enqueuedAt === undefined ? {} : { enqueuedAt: input.enqueuedAt }),
  });
}
