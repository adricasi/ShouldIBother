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
  /**
   * `SIB_FAKE_MODEL=1`: the recorded-fixture model, for CI, tests and `npm run dev` only. It is
   * never chosen for any other reason, so fixtures can not pose as Gemma by accident.
   */
  readonly useFake: boolean;
  /** Builds the fake model; only called when `useFake` is true. */
  readonly fake: () => ModelClient;
  readonly fetch?: typeof fetch;
}

/** Why the app refuses to start without a model tag; names the file and the escape hatch. */
export function missingModelMessage(config: ModelsConfig): string {
  return (
    `No Gemma model is configured: config/models.json has no models.${config.primary}.tag. ` +
    `Set it, for example "models": { "${config.primary}": { "tag": "gemma4:e4b" } } ` +
    `(the tag from \`ollama list\`). To run on recorded fixtures instead (CI, tests, ` +
    `\`npm run dev\`), start with SIB_FAKE_MODEL=1.`
  );
}

/**
 * `sib start` talks to Ollama. The fake model is used only when `SIB_FAKE_MODEL=1` says so
 * explicitly. With no model tag configured the app refuses to start; with Ollama down it starts
 * anyway and Gemma shows offline (rule odds, Retry, settlements wait), so Ollama can be started
 * later without restarting the app.
 */
export async function selectModel(
  config: ModelsConfig,
  options: SelectOptions,
): Promise<ModelSelection> {
  if (options.useFake) {
    return {
      model: options.fake(),
      mode: "fake",
      notice: [
        "!!! FAKE MODEL (SIB_FAKE_MODEL=1) !!!",
        "Odds, listener results and verdicts come from recorded fixtures, NOT from Gemma.",
        'Do not place real bets on this. Today shows "(fake model)".',
      ].join("\n"),
    };
  }
  const tag = primaryModelTag(config);
  if (tag === undefined) {
    throw new Error(missingModelMessage(config));
  }
  const client = new OllamaClient({
    baseUrl: config.ollama.baseUrl,
    model: tag,
    keepAlive: config.ollama.keepAlive,
    temperature: config.ollama.temperature,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const health = await client.health();
  const where = `${tag} on Ollama at ${config.ollama.baseUrl}`;
  return {
    model: client,
    mode: "ollama",
    notice:
      health.state === "offline"
        ? `Gemma: ${where} is not usable yet (${health.detail ?? "no answer"}). Cards show rule odds and "Gemma offline" until it is; settlements wait.`
        : `Gemma: ${where}, loading it now (keep_alive ${String(config.ollama.keepAlive)}).`,
    warmUp: () => client.warmUp(),
  };
}
