import { z } from "zod";

/**
 * The JSON schema sent to the runtime for a job's zod schema (zod 4's built-in conversion). The
 * `$schema` marker is dropped: the runtime wants the schema itself. Checks zod runs after parsing
 * (`refine`, the job's `check`) are not part of it; the runner enforces them on the answer.
 */
export function jobJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const converted: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete converted["$schema"];
  return converted;
}
