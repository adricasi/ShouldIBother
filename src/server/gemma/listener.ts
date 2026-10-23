import { z } from "zod";

import { JobRunner, type JobResult } from "./runner.js";
import { loadPrompt } from "./prompts.js";
import { untrustedBlock } from "./untrusted.js";

export const LISTENER_PROMPT = loadPrompt("listener", 1);

/** The longest sentence the listener reads (AC-002.1). */
export const MAX_CAPTURE_CHARS = 500;
/** Chores found in one sentence; more than this is a model error. */
export const MAX_CHORES_PER_SENTENCE = 5;

export const LISTENER_CHORE_TYPES = [
  "plants",
  "laundry_line",
  "laundry_tonight",
  "laundry_plan",
  "ac",
  "heater",
  "other_weather",
  "not_weather",
] as const;
export type ListenerChoreType = (typeof LISTENER_CHORE_TYPES)[number];

/** Output of the listener (design.md, Gemma jobs). Enums plus short strings. */
export const listenerOutputSchema = z
  .object({
    chores: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(80),
            chore_type: z.enum(LISTENER_CHORE_TYPES),
            item: z.string().max(80).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CHORES_PER_SENTENCE),
  })
  .strict();

export type ListenerOutput = z.infer<typeof listenerOutputSchema>;
export type ListenerChore = ListenerOutput["chores"][number];

/** Asks the listener to split a sentence into chores (REQ-002); a voice transcript too (REQ-027). */
export function runListener(
  runner: JobRunner,
  text: string,
  source: "typed" | "voice" = "typed",
): Promise<JobResult<ListenerOutput>> {
  return runner.run({
    job: "listener",
    prompt: LISTENER_PROMPT,
    user: untrustedBlock({ text }),
    schema: listenerOutputSchema,
    // The sentence is household text: only its length is stored with the decision.
    inputSummary: `${source === "voice" ? "voice transcript" : "typed text"}, ${text.length} chars`,
  });
}
