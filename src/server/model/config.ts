import { existsSync } from "node:fs";

import { z } from "zod";

import { CONFIG_DIR, readJsonFile } from "../config.js";

import { loopbackOrigin } from "./loopback.js";

/** A runtime stays on 127.0.0.1 (NFR-001, AGENTS.md): any other host in config is an error. */
function loopbackUrl(runtime: string) {
  return z.string().transform((value, ctx) => {
    const origin = loopbackOrigin(value);
    if (origin !== undefined) {
      return origin;
    }
    ctx.addIssue({
      code: "custom",
      message: `${runtime} must be an http URL on 127.0.0.1 or [::1], got ${JSON.stringify(value)}`,
    });
    return z.NEVER;
  });
}

const modelEntrySchema = z
  .object({
    /** Ollama tag, e.g. `gemma4:e4b`. */
    tag: z.string().min(1),
    quantization: z.string().optional(),
    /** Pinned digest, checked by `npm run setup` (T-001, T-010). */
    digest: z.string().optional(),
  })
  .strict();

export const modelsConfigSchema = z
  .object({
    _comment: z.string().optional(),
    /** Key in `models` of the model the app uses. */
    primary: z.string().min(1).default("e4b"),
    ollama: z
      .object({
        baseUrl: loopbackUrl("Ollama").default("http://127.0.0.1:11434"),
        /** How long Ollama keeps the model loaded; long for the live week (design.md). */
        keepAlive: z.union([z.string().min(1), z.number()]).default("24h"),
        temperature: z.number().min(0).max(2).default(0),
      })
      .strict()
      .prefault({}),
    /** The llama.cpp server for voice capture (flag `voice`, REQ-027); 127.0.0.1 only. */
    llamaCpp: z
      .object({
        baseUrl: loopbackUrl("llama.cpp").default("http://127.0.0.1:8080"),
        /** Name recorded with each voice decision; llama.cpp serves the one model it was started with. */
        model: z.string().min(1).default("gemma4-audio"),
      })
      .strict()
      .prefault({}),
    gemma: z
      .object({
        /** `injected` is the T-001 fallback: the app passes the forecast as the tool result. */
        toolUse: z.enum(["native", "injected"]).default("native"),
        /** `two_step` sends the tool first and the answer schema with the second call. */
        answerMode: z.enum(["single_call", "two_step"]).default("single_call"),
      })
      .strict()
      .prefault({}),
    models: z.record(z.string(), modelEntrySchema).default({}),
  })
  .strict();

export type ModelsConfig = z.infer<typeof modelsConfigSchema>;

export const DEFAULT_MODELS_PATH = `${CONFIG_DIR}models.json`;

export function parseModelsConfig(raw: unknown): ModelsConfig {
  const result = modelsConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid models config: ${result.error.message}`);
  }
  return result.data;
}

/** A missing file is the defaults: no model named, so the app runs on the fake model. */
export function loadModelsConfig(path: string = DEFAULT_MODELS_PATH): ModelsConfig {
  return parseModelsConfig(existsSync(path) ? readJsonFile(path) : {});
}

/** The Ollama tag of the primary model, or undefined while `config/models.json` names none. */
export function primaryModelTag(config: ModelsConfig): string | undefined {
  return config.models[config.primary]?.tag;
}
