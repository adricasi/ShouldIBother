import type { ModelClient, ModelHealth } from "./client.js";
import { primaryModelTag, type ModelsConfig } from "./config.js";
import { OllamaClient } from "./ollama.js";

export interface ModelSelection {
  readonly model: ModelClient;
  readonly mode: "ollama" | "fake";
  /** One line for the console: which model the app runs on and why. */
  readonly notice: string;
  /** Loads the real model in the background (`ollama` mode only); never throws. */
  readonly warmUp?: () => Promise<ModelHealth>;
}

export interface SelectOptions {
  /** The fake model for CI and for a machine without Ollama. */
  readonly fake: () => ModelClient;
  readonly fetch?: typeof fetch;
}

/**
 * `sib start` uses Ollama when `config/models.json` names a model and Ollama answers with it;
 * otherwise the fake model, with a clear notice so recorded fixtures are never mistaken for Gemma.
 */
export async function selectModel(
  config: ModelsConfig,
  options: SelectOptions,
): Promise<ModelSelection> {
  const tag = primaryModelTag(config);
  if (tag === undefined) {
    return {
      model: options.fake(),
      mode: "fake",
      notice: `FAKE MODEL: config/models.json names no model for "${config.primary}", so odds come from recorded fixtures, not Gemma.`,
    };
  }
  const client = new OllamaClient({
    baseUrl: config.ollama.baseUrl,
    model: tag,
    keepAlive: config.ollama.keepAlive,
    temperature: config.ollama.temperature,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const health = await client.health();
  if (health.state === "offline") {
    return {
      model: options.fake(),
      mode: "fake",
      notice: `FAKE MODEL: Ollama (${tag}) is not usable at ${config.ollama.baseUrl} (${health.detail ?? "no answer"}), so odds come from recorded fixtures, not Gemma. Start Ollama and restart.`,
    };
  }
  return {
    model: client,
    mode: "ollama",
    notice: `Gemma: ${tag} on Ollama at ${config.ollama.baseUrl}, loading it now (keep_alive ${String(config.ollama.keepAlive)}).`,
    warmUp: () => client.warmUp(),
  };
}
