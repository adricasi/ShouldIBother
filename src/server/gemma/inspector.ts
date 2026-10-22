import { z } from "zod";

import { CHORES, type ChoreType } from "../../domain/chores.js";

import { loadPrompt } from "./prompts.js";
import type { JobResult, JobRunner } from "./runner.js";
import { untrustedBlock } from "./untrusted.js";

export const INSPECTOR_PROMPT = loadPrompt("inspector", 1);

/** What the inspector may report (design.md, Gemma jobs; AC-005.2). */
export const OBSERVATION_NAMES = ["item", "soil_dryness", "wilting", "cover", "dampness"] as const;
export type ObservationName = (typeof OBSERVATION_NAMES)[number];

/** Plain words for the "What Gemma saw" list (AC-005.3). */
export const OBSERVATION_LABELS: Readonly<Record<ObservationName, string>> = {
  item: "Item",
  soil_dryness: "Soil",
  wilting: "Wilting",
  cover: "Cover from rain",
  dampness: "Dampness",
};

export const MAX_OBSERVATIONS = 6;
export const MAX_OBSERVATION_VALUE_CHARS = 40;

/**
 * Output of the inspector (design.md, Gemma jobs): `ok` carries observations, `unsure` a yes/no
 * question. Enum names plus short strings; code never acts on the free text.
 */
export const inspectorOutputSchema = z
  .object({
    status: z.enum(["ok", "unsure"]),
    observations: z
      .array(
        z
          .object({
            name: z.enum(OBSERVATION_NAMES),
            value: z.string().trim().min(1).max(MAX_OBSERVATION_VALUE_CHARS),
          })
          .strict(),
      )
      .max(MAX_OBSERVATIONS)
      .optional(),
    question: z.string().max(200).optional(),
  })
  .strict()
  .refine((value) => value.status !== "ok" || (value.observations ?? []).length > 0, {
    message: 'status "ok" needs at least one observation',
  })
  .refine((value) => value.status !== "unsure" || (value.question ?? "").trim() !== "", {
    message: 'status "unsure" needs a yes/no question',
  });

export type InspectorOutput = z.infer<typeof inspectorOutputSchema>;
export type Observation = NonNullable<InspectorOutput["observations"]>[number];

export interface InspectorInput {
  readonly chore: ChoreType;
  /** The re-encoded photo (no metadata, at most 1024 px). */
  readonly image: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly cardId: number;
  readonly photoId: string;
  /** Shared with the bookmaker run that follows: one 45 s deadline for the photo (requirements). */
  readonly enqueuedAt: number;
}

/** Asks the inspector what it sees in a before photo (REQ-005, AC-005.2). */
export function runInspector(
  runner: JobRunner,
  input: InspectorInput,
): Promise<JobResult<InspectorOutput>> {
  return runner.run({
    job: "inspector",
    prompt: INSPECTOR_PROMPT,
    user: untrustedBlock({ chore: CHORES[input.chore].judgeName, chore_type: input.chore }),
    images: [input.image],
    schema: inspectorOutputSchema,
    cardId: input.cardId,
    photoId: input.photoId,
    // The photo itself never goes into the log, only its size.
    inputSummary: `${input.chore} photo, ${input.width}x${input.height}`,
    enqueuedAt: input.enqueuedAt,
  });
}
