import { z } from "zod";

import {
  PLAN_DAY_KEYS,
  PLAN_STATES,
  type PlanDayFacts,
  type PlanDayKey,
} from "../../domain/laundry-plan.js";
import { madridParts } from "../../domain/time.js";

import { BAND_NAMES, bandOfName, nameOfOrdinal, type QuestionAnswer } from "./bookmaker.js";
import { loadPrompt } from "./prompts.js";
import type { JobResult, JobRunner } from "./runner.js";
import { untrustedBlock } from "./untrusted.js";

export const LAUNDRY_PLANNER_JOB = "laundry-planner";
export const LAUNDRY_PLANNER_PROMPT = loadPrompt(LAUNDRY_PLANNER_JOB, 1);

/** The reason line is one sentence of at most 140 characters (design.md, Gemma jobs). */
export const MAX_PLANNER_REASON_CHARS = 140;

/** A wash or a skip needs a day at least this good: "toss up" is band 2. */
const GOOD_ENOUGH_BAND = bandOfName("toss_up");

const dayScoreSchema = z.object({ day: z.enum(PLAN_DAY_KEYS), score: z.enum(BAND_NAMES) }).strict();

/**
 * Output of the laundry planner (design.md, Gemma jobs: `state; best_day; days[]: {date, score}`).
 * A day is named by its key (`day_0` is today), never by a date Gemma would have to copy; `score`
 * is the band of the chance a load dries outside that day, so a Skip today bet takes its band from
 * it (AC-021.5). `unsure` carries a yes/no question like every other job.
 *
 * The consistency of the answer is checked here, in code: the best day has the best score, a wash
 * today is on a day that is the best and good enough, a skip names a later day that beats today,
 * and "no good day" means no day better than unlikely. An answer that contradicts its own scores
 * is invalid and gets the single retry.
 */
export const laundryPlannerOutputSchema = z
  .object({
    status: z.enum(["ok", "unsure"]),
    state: z.enum(PLAN_STATES).optional(),
    best_day: z.enum(PLAN_DAY_KEYS).optional(),
    days: z.array(dayScoreSchema).max(PLAN_DAY_KEYS.length).optional(),
    reason: z.string().max(MAX_PLANNER_REASON_CHARS).optional(),
    question: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const problem = planProblem(value);
    if (problem !== undefined) {
      context.addIssue({ code: "custom", message: problem });
    }
  });

export type LaundryPlannerOutput = z.infer<typeof laundryPlannerOutputSchema>;

type RawOutput = {
  status: "ok" | "unsure";
  state?: (typeof PLAN_STATES)[number] | undefined;
  best_day?: PlanDayKey | undefined;
  days?: { day: PlanDayKey; score: (typeof BAND_NAMES)[number] }[] | undefined;
  reason?: string | undefined;
  question?: string | undefined;
};

/** Why an answer contradicts itself, or undefined when it holds together. */
function planProblem(value: RawOutput): string | undefined {
  if (value.status === "unsure") {
    return (value.question ?? "").trim() === ""
      ? 'status "unsure" needs a yes/no question'
      : undefined;
  }
  if (value.state === undefined || (value.reason ?? "").trim() === "") {
    return 'status "ok" needs state and reason';
  }
  const scores = scoresOf(value.days);
  if (scores === undefined) {
    return `"days" needs exactly one score for each of ${PLAN_DAY_KEYS.join(", ")}`;
  }
  const best = Math.max(...PLAN_DAY_KEYS.map((key) => scores[key]));
  if (value.state === "no_good_day") {
    if (value.best_day !== undefined) {
      return '"no_good_day" has no "best_day"';
    }
    return best > bandOfName("unlikely")
      ? `"no_good_day" is only for when no day is better than "unlikely", but one scores ${nameOfOrdinal(best as 0 | 1 | 2 | 3 | 4)}`
      : undefined;
  }
  if (value.best_day === undefined) {
    return `"${value.state}" needs a "best_day"`;
  }
  if (scores[value.best_day] !== best) {
    return `"best_day" ${value.best_day} must be the day with the highest score`;
  }
  if (best < GOOD_ENOUGH_BAND) {
    return `"${value.state}" needs a day that scores "toss_up" or better; otherwise answer "no_good_day"`;
  }
  if (value.state === "wash_today") {
    return value.best_day === "day_0" ? undefined : '"wash_today" means "day_0" is the best day';
  }
  if (value.best_day === "day_0") {
    return '"skip_today" needs a later day as "best_day"; answer "wash_today" if today is the best';
  }
  return scores[value.best_day] > scores.day_0
    ? undefined
    : '"skip_today" needs a later day that scores better than today';
}

/** The band of each day by key; undefined unless the list has each of the four days once. */
function scoresOf(days: RawOutput["days"]): Record<PlanDayKey, number> | undefined {
  if (days?.length !== PLAN_DAY_KEYS.length) {
    return undefined;
  }
  const scores: Partial<Record<PlanDayKey, number>> = {};
  for (const entry of days) {
    if (scores[entry.day] !== undefined) {
      return undefined;
    }
    scores[entry.day] = bandOfName(entry.score);
  }
  return PLAN_DAY_KEYS.every((key) => scores[key] !== undefined)
    ? (scores as Record<PlanDayKey, number>)
    : undefined;
}

export interface LaundryPlannerInput {
  /** What the person wrote about the load; untrusted. */
  readonly label: string;
  readonly nowMs: number;
  readonly days: readonly PlanDayFacts[];
  readonly answers: readonly QuestionAnswer[];
  readonly cardId: number;
  readonly enqueuedAt?: number;
}

function localTime(epochMs: number): string {
  const t = madridParts(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}`;
}

/** The data block of the planner prompt: four days of numbers computed by code. */
export function laundryPlannerUserMessage(input: LaundryPlannerInput): string {
  return untrustedBlock({
    task: "plan the washing",
    person_wrote: input.label,
    now_europe_madrid: localTime(input.nowMs),
    days: input.days.map((day) => ({
      key: day.key,
      weekday: day.weekday,
      date: day.date,
      drying_window:
        day.window === null
          ? null
          : { from: localTime(day.window.fromMs), to: localTime(day.window.toMs) },
      forecast_complete: day.covered,
      rain_mm: day.rainMm,
      wet_hours: day.wetHours,
      max_rain_probability_pct: day.maxRainProbabilityPct,
      temp_max_c: day.tempMaxC,
      wind_mean_kmh: day.windMeanKmh,
      humidity_mean_pct: day.humidityMeanPct,
      sunshine_h: day.sunshineH,
      drying_index: day.dryingIndex,
      rule_band: day.ruleBand === null ? null : nameOfOrdinal(day.ruleBand),
    })),
    answers_so_far: input.answers.map((answer) => ({
      question: answer.question,
      answer: answer.yes ? "yes" : "no",
    })),
  });
}

/**
 * What the days' facts rule out, as a message for the retry: a day with no drying hours left
 * scores "very_unlikely", and a skip needs a day the forecast covers (its rule band is stored on
 * the bet).
 */
export function laundryPlannerCheck(
  input: LaundryPlannerInput,
): (output: LaundryPlannerOutput) => string | undefined {
  return (output) => {
    if (output.status !== "ok" || output.days === undefined) {
      return undefined;
    }
    for (const entry of output.days) {
      const day = input.days.find((candidate) => candidate.key === entry.day);
      if (day?.window === null && entry.score !== "very_unlikely") {
        return `${entry.day} has no drying hours left, so its score must be "very_unlikely"`;
      }
      if (day !== undefined && !day.covered && entry.score !== "very_unlikely") {
        return `${entry.day} has no usable forecast, so its score must be "very_unlikely"`;
      }
    }
    return undefined;
  };
}

/** Asks the laundry planner to score the next four days (REQ-021, AC-021.1). */
export function runLaundryPlanner(
  runner: JobRunner,
  input: LaundryPlannerInput,
): Promise<JobResult<LaundryPlannerOutput>> {
  return runner.run({
    job: LAUNDRY_PLANNER_JOB,
    prompt: LAUNDRY_PLANNER_PROMPT,
    user: laundryPlannerUserMessage(input),
    schema: laundryPlannerOutputSchema,
    check: laundryPlannerCheck(input),
    cardId: input.cardId,
    // The person's words are household text: only counts are stored with the decision.
    inputSummary: `laundry planner, ${input.days.length} days, ${input.answers.length} answers`,
    ...(input.enqueuedAt === undefined ? {} : { enqueuedAt: input.enqueuedAt }),
  });
}
