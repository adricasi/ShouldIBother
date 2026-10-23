import type { ModelClient, ModelHealth } from "./client.js";
import { primaryModelTag, type ModelsConfig } from "./config.js";
import { LISTENER_AUDIO_JOB } from "../gemma/listener-audio.js";
import { LlamaCppAudioClient } from "./llamacpp.js";
import { OllamaClient } from "./ollama.js";

export interface ModelSelection {
  readonly model: ModelClient;
  readonly mode: "ollama" | "fake";
  /** One line for the console: which model the app runs on and why. */
  readonly notice: string;
  /**
   * Runtimes for single jobs (by job name), used instead of `model`: the llama.cpp audio client
   * for the voice job while the `voice` flag is on. Empty on the fake model, which answers every
   * job from fixtures.
   */
  readonly jobModels: Readonly<Partial<Record<string, ModelClient>>>;
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
  /** Flag `voice`: also set up the llama.cpp audio client (REQ-027). Ignored on the fake model. */
  readonly voice?: boolean;
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
      jobModels: {},
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
  const voice = options.voice === true ? await setUpVoice(config, options.fetch) : undefined;
  const notice =
    health.state === "offline"
      ? `Gemma: ${where} is not usable yet (${health.detail ?? "no answer"}). Cards show rule odds and "Gemma offline" until it is; settlements wait.`
      : `Gemma: ${where}, loading it now (keep_alive ${String(config.ollama.keepAlive)}).`;
  return {
    model: client,
    mode: "ollama",
    jobModels: voice === undefined ? {} : { [LISTENER_AUDIO_JOB]: voice.client },
    notice: voice === undefined ? notice : `${notice}\n${voice.notice}`,
    warmUp: () => client.warmUp(),
  };
}

/** The voice job's runtime (flag `voice`): llama.cpp on 127.0.0.1, which may start after the app. */
async function setUpVoice(
  config: ModelsConfig,
  fetchImpl: typeof fetch | undefined,
): Promise<{ client: ModelClient; notice: string }> {
  const client = new LlamaCppAudioClient({
    baseUrl: config.llamaCpp.baseUrl,
    model: config.llamaCpp.model,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  const health = await client.health();
  const where = `llama.cpp audio at ${config.llamaCpp.baseUrl}`;
  return {
    client,
    notice:
      health.state === "offline"
        ? `Voice: ${where} is not answering yet (${health.detail ?? "no answer"}). The mic shows an error until it is; typed capture works.`
        : `Voice: ${where} is up.`,
  };
}
