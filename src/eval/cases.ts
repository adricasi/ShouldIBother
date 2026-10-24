import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { ADVICE_CHORE_TYPES } from "../domain/advice.js";
import { CHORES, CHORE_TYPES, LAUNDRY_PLAN, LAUNDRY_PLAN_SPEC } from "../domain/chores.js";
import { assertIsoDate } from "../domain/time.js";

import { weatherSpecSchema } from "./weather.js";

/** The Gemma jobs `sib eval <job>` can run. */
export const EVAL_JOBS = [
  "listener",
  "bookmaker",
  "inspector",
  "judge",
  "safety",
  "laundry-planner",
  "advisor",
] as const;
export type EvalJob = (typeof EVAL_JOBS)[number];

export function isEvalJob(value: string | undefined): value is EvalJob {
  return EVAL_JOBS.some((job) => job === value);
}

/** `evals/<job>/cases.json`, the staged case sets that are committed (synthetic text only). */
export const EVALS_DIR = fileURLToPath(new URL("../../evals/", import.meta.url));

export function defaultCasesPath(job: EvalJob): string {
  return `${EVALS_DIR}${job}/cases.json`;
}

export class CaseFileError extends Error {
  override readonly name = "CaseFileError";
}

/** A case id is also the fixture scenario name, so it follows the fixture naming rule. */
const caseId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lower-case letters, digits and -");

/** The Madrid wall-clock time the case happens at: `YYYY-MM-DD HH:MM`. */
const nowSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "write the time as YYYY-MM-DD HH:MM")
  .refine((value) => {
    try {
      assertIsoDate(value.slice(0, 10));
      return true;
    } catch {
      return false;
    }
  }, "not a real date");

/** A staged photo: a plain file name inside the `--photos` folder, never a path. */
export const photoName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp)$/i, "a file name like plants-01.jpg");

const base = {
  id: caseId,
  /** Why the case is in the set (an edge case, an ambiguity). Not sent to the model. */
  note: z.string().max(300).optional(),
  /**
   * What the case is expected to come out as (informational: it never changes the exit code). The
   * keys are per job: see `answerKey` in `jobs.ts`.
   */
  expect: z.array(z.string().min(1)).min(1).max(8).optional(),
};

const choreType = z.enum(CHORE_TYPES);
const answerSchema = z.object({ question: z.string().min(1).max(200), yes: z.boolean() }).strict();

export const listenerCaseSchema = z
  .object({ ...base, text: z.string().trim().min(1).max(500) })
  .strict();

export const bookmakerCaseSchema = z
  .object({
    ...base,
    chore: choreType,
    /** What the person wrote on the card; sent to Gemma inside the untrusted block. */
    text: z.string().trim().min(1).max(200),
    now: nowSchema,
    weather: weatherSpecSchema,
    answers: z.array(answerSchema).max(3).default([]),
    habits: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
  })
  .strict();

export const inspectorCaseSchema = z
  .object({
    ...base,
    chore: choreType,
    text: z.string().trim().min(1).max(200),
    now: nowSchema,
    weather: weatherSpecSchema,
    /** The staged before photo in the `--photos` folder. */
    photo: photoName,
    /** What the builder stages for this case; shown when the photo is missing. */
    staging: z.string().min(1).max(300),
  })
  .strict();

const judgeEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), answer: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("weather") }).strict(),
  z
    .object({
      kind: z.literal("photo"),
      before: photoName.optional(),
      /** What to stage for the before photo; required with `before`. */
      beforeStaging: z.string().min(1).max(300).optional(),
      after: photoName,
      /** What to stage for the after photo. */
      staging: z.string().min(1).max(300),
    })
    .strict()
    .refine((value) => (value.before === undefined) === (value.beforeStaging === undefined), {
      message: '"before" and "beforeStaging" go together',
    }),
]);

export const judgeCaseSchema = z
  .object({
    ...base,
    chore: z.enum([...CHORE_TYPES, LAUNDRY_PLAN]),
    kind: z.enum(["do_nothing", "do_it"]),
    /** The odds locked on the bet: 15, 35, 50, 70 or 85. */
    odds: z.union([z.literal(15), z.literal(35), z.literal(50), z.literal(70), z.literal(85)]),
    evidence: judgeEvidenceSchema,
    /** The modelled recent weather of the bet's window; null when there is none. */
    weather: weatherSpecSchema.nullable(),
    weatherHours: z.number().int().min(1).max(48).default(24),
    followups: z.array(answerSchema).max(2).default([]),
    canAsk: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.evidence.kind !== "tap") {
      return;
    }
    const spec = value.chore === LAUNDRY_PLAN ? LAUNDRY_PLAN_SPEC : CHORES[value.chore];
    const answer = value.evidence.answer;
    if (!spec.tapAnswers.some((candidate) => candidate.id === answer)) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "answer"],
        message: `"${answer}" is not a tap answer of ${value.chore}: ${spec.tapAnswers.map((a) => a.id).join(", ")}`,
      });
    }
  });

export const safetyCaseSchema = z
  .object({
    ...base,
    chore: choreType,
    text: z.string().trim().min(1).max(300),
    now: nowSchema,
    weather: weatherSpecSchema,
  })
  .strict();

export const plannerCaseSchema = z
  .object({
    ...base,
    text: z.string().trim().min(1).max(200),
    now: nowSchema,
    weather: weatherSpecSchema,
    answers: z.array(answerSchema).max(3).default([]),
  })
  .strict();

export const advisorCaseSchema = z
  .object({
    ...base,
    chore: z.enum(ADVICE_CHORE_TYPES),
    text: z.string().trim().min(1).max(200),
    now: nowSchema,
    weather: weatherSpecSchema,
  })
  .strict();

export type ListenerCase = z.infer<typeof listenerCaseSchema>;
export type BookmakerCase = z.infer<typeof bookmakerCaseSchema>;
export type InspectorCase = z.infer<typeof inspectorCaseSchema>;
export type JudgeCase = z.infer<typeof judgeCaseSchema>;
export type SafetyCase = z.infer<typeof safetyCaseSchema>;
export type PlannerCase = z.infer<typeof plannerCaseSchema>;
export type AdvisorCase = z.infer<typeof advisorCaseSchema>;

/** The shape of a case file: the job it is for and its cases. */
export function caseFileSchema<T extends z.ZodType>(job: EvalJob, caseSchema: T) {
  return z
    .object({
      _comment: z.string().optional(),
      job: z.literal(job),
      cases: z
        .array(caseSchema)
        .min(1)
        .superRefine((cases, context) => {
          const seen = new Set<string>();
          for (const [index, entry] of cases.entries()) {
            const id = (entry as { id: string }).id;
            if (seen.has(id)) {
              context.addIssue({
                code: "custom",
                path: [index, "id"],
                message: `duplicate id ${id}`,
              });
            }
            seen.add(id);
          }
        }),
    })
    .strict();
}

/** Reads and validates a case file; every problem names the file and the case. */
export function readCaseFile<T extends z.ZodType>(
  path: string,
  job: EvalJob,
  caseSchema: T,
): z.infer<T>[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CaseFileError(
      `Cannot read the case file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = caseFileSchema(job, caseSchema).safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`)
      .join("; ");
    throw new CaseFileError(`Invalid case file ${path}: ${issues}`);
  }
  return parsed.data.cases;
}
