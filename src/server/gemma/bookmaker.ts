import { z } from "zod";

import type { Band } from "../../domain/bands.js";
import { CHORES, type ChoreType } from "../../domain/chores.js";
import { madridParts } from "../../domain/time.js";
import { HOUR_MS } from "../../domain/weather.js";
import { clampSettle, settleBoundsOf } from "../ledger/chore-rules.js";

import { createForecastTool, type ForecastReader } from "./forecast-tool.js";
import { loadPrompt } from "./prompts.js";
import type { JobResult, JobRunner } from "./runner.js";
import { untrustedBlock } from "./untrusted.js";

export const BOOKMAKER_PROMPT = loadPrompt("bookmaker", 1);

/** The five bands Gemma names, lowest odds first; the index is the ordinal band 0..4. */
export const BAND_NAMES = [
  "very_unlikely",
  "unlikely",
  "toss_up",
  "likely",
  "very_likely",
] as const;
export type BandName = (typeof BAND_NAMES)[number];

export function bandOfName(name: BandName): Band {
  return BAND_NAMES.indexOf(name) as Band;
}

export function nameOfOrdinal(band: Band): BandName {
  return BAND_NAMES[band];
}

/** The reason line is at most 140 characters (design.md, Gemma jobs). */
export const MAX_REASON_CHARS = 140;

/**
 * Output of the bookmaker (design.md, Gemma jobs). `ok` carries a band, a reason and a settle
 * time; `unsure` carries a yes/no question. The fields the status needs are checked after parsing
 * so the JSON schema sent to the runtime stays one flat object.
 */
export const bookmakerOutputSchema = z
  .object({
    status: z.enum(["ok", "unsure"]),
    band: z.enum(BAND_NAMES).optional(),
    reason: z.string().max(MAX_REASON_CHARS).optional(),
    settle_in_hours: z.number().min(0).max(240).optional(),
    disagreement_reason: z.string().max(200).optional(),
    question: z.string().max(200).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== "ok" ||
      (value.band !== undefined &&
        value.reason !== undefined &&
        value.reason.trim() !== "" &&
        value.settle_in_hours !== undefined),
    { message: 'status "ok" needs band, reason and settle_in_hours' },
  )
  .refine((value) => value.status !== "unsure" || (value.question ?? "").trim() !== "", {
    message: 'status "unsure" needs a yes/no question',
  });

export type BookmakerOutput = z.infer<typeof bookmakerOutputSchema>;

export interface QuestionAnswer {
  readonly question: string;
  readonly yes: boolean;
}

export interface BookmakerInput {
  readonly chore: ChoreType;
  /** What the person wrote about the chore; untrusted. */
  readonly label: string;
  readonly nowMs: number;
  /** Rule band for the card's window at the time of asking (shown to Gemma, AC-004.3). */
  readonly ruleBand: Band;
  /** The rule's band for a given settle time, to check how far Gemma is from it (AC-004.3). */
  readonly ruleBandAt: (settleAtMs: number) => Band;
  readonly answers: readonly QuestionAnswer[];
  /** Reads the forecast the weather tool serves. */
  readonly readForecast: ForecastReader;
  readonly cardId: number;
  /** Habits of the household as short facts; empty until onboarding exists. */
  readonly habits?: Readonly<Record<string, string | boolean>>;
  /** What the inspector saw in the photo (T-007). */
  readonly observations?: readonly { readonly name: string; readonly value: string }[];
  readonly enqueuedAt?: number;
  /** The photo whose observations are in the input: the decision is filed under it (AC-015.2). */
  readonly photoId?: string;
}

function localTime(epochMs: number): string {
  const t = madridParts(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}`;
}

/** The data block of the bookmaker prompt: enums, numbers and the person's own words. */
export function bookmakerUserMessage(input: BookmakerInput): string {
  const bounds = settleBoundsOf(input.chore, input.nowMs);
  const hoursFromNow = (epochMs: number): number =>
    Math.max(0, Math.round(((epochMs - input.nowMs) / HOUR_MS) * 10) / 10);
  return untrustedBlock({
    chore: CHORES[input.chore].judgeName,
    chore_type: input.chore,
    person_wrote: input.label,
    now_europe_madrid: localTime(input.nowMs),
    settle_in_hours_between: [hoursFromNow(bounds.earliestMs), hoursFromNow(bounds.latestMs)],
    rule_band: nameOfOrdinal(input.ruleBand),
    habits: input.habits ?? {},
    ...(input.observations === undefined || input.observations.length === 0
      ? {}
      : { photo_observations: input.observations }),
    answers_so_far: input.answers.map((answer) => ({
      question: answer.question,
      answer: answer.yes ? "yes" : "no",
    })),
  });
}

/** The settle time the answer stands for, clamped into the chore's bounds. */
export function settleAtOf(chore: ChoreType, nowMs: number, settleInHours: number): number {
  return clampSettle(chore, nowMs, nowMs + Math.round(settleInHours * HOUR_MS));
}

/** How many bands an `ok` answer is from the rule band for its own settle time; undefined if unsure. */
export function distanceFromRule(
  input: BookmakerInput,
  output: BookmakerOutput,
): number | undefined {
  if (output.status !== "ok" || output.band === undefined || output.settle_in_hours === undefined) {
    return undefined;
  }
  const ruleBand = input.ruleBandAt(settleAtOf(input.chore, input.nowMs, output.settle_in_hours));
  return Math.abs(bandOfName(output.band) - ruleBand);
}

/** The bookmaker's own consistency rule (AC-004.3), as a message for the retry. */
export function bookmakerCheck(
  input: BookmakerInput,
): (output: BookmakerOutput) => string | undefined {
  return (output) => {
    const distance = distanceFromRule(input, output);
    if (distance === undefined || distance < 2) {
      return undefined;
    }
    const explained = (output.disagreement_reason ?? "").trim() !== "";
    const asks = (output.question ?? "").trim() !== "";
    if (explained || asks) {
      return undefined;
    }
    const ruleBand = input.ruleBandAt(
      settleAtOf(input.chore, input.nowMs, output.settle_in_hours ?? 0),
    );
    return `Your band "${output.band ?? ""}" is two or more bands from the rule band "${nameOfOrdinal(ruleBand)}". Say why in "disagreement_reason", or ask the person one yes/no "question".`;
  };
}

/** Asks the bookmaker for a band, a reason and a settle time (REQ-003); `get_forecast` is required. */
export function runBookmaker(
  runner: JobRunner,
  input: BookmakerInput,
): Promise<JobResult<BookmakerOutput>> {
  const bounds = settleBoundsOf(input.chore, input.nowMs);
  return runner.run({
    job: "bookmaker",
    prompt: BOOKMAKER_PROMPT,
    user: bookmakerUserMessage(input),
    schema: bookmakerOutputSchema,
    check: bookmakerCheck(input),
    tool: createForecastTool(input.readForecast, {
      required: true,
      // Enough hours to cover the window up to the latest settle time.
      injectedHoursAhead: Math.ceil((bounds.latestMs - input.nowMs) / HOUR_MS),
    }),
    cardId: input.cardId,
    ...(input.photoId === undefined ? {} : { photoId: input.photoId }),
    inputSummary: `${input.chore} card, rule band ${input.ruleBand}, ${input.answers.length} answers${
      input.photoId === undefined ? "" : `, ${input.observations?.length ?? 0} photo observations`
    }`,
    ...(input.enqueuedAt === undefined ? {} : { enqueuedAt: input.enqueuedAt }),
  });
}
