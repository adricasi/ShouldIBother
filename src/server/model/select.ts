import type { ModelClient, ModelHealth } from "./client.js";
import {
  FINETUNED_MODEL_KEY,
  finetunedModelTag,
  primaryModelTag,
  type ModelsConfig,
} from "./config.js";
import { LISTENER_AUDIO_JOB } from "../gemma/listener-audio.js";
import type { Db } from "../db.js";
import type { HostedSettings } from "../mode.js";
import { CappedModelClient, type ModelCapLogEntry } from "./capped.js";
import { DIGITALOCEAN_INFERENCE_URL, DigitalOceanClient } from "./digitalocean.js";
import { LlamaCppAudioClient } from "./llamacpp.js";
import { OllamaClient } from "./ollama.js";

export interface ModelSelection {
  readonly model: ModelClient;
  readonly mode: "ollama" | "fake" | "digitalocean";
  /** One line for the console: which model the app runs on and why. */
  readonly notice: string;
  /**
   * Runtimes for single jobs (by job name), used instead of `model`: the llama.cpp audio client
   * for the voice job while the `voice` flag is on, and the fine-tuned model for the bookmaker
   * while `finetunedBookmaker` is on and `models.e4b-ft` exists. Empty on the fake model, which
   * answers every job from fixtures.
   */
  readonly jobModels: Readonly<Partial<Record<string, ModelClient>>>;
  /** Loads the real model in the background (`ollama` mode only); never throws. */
  readonly warmUp?: () => Promise<ModelHealth>;
}

/** Hosted mode (REQ-032): Gemma from DigitalOcean's inference API instead of Ollama. */
export interface HostedModelOptions {
  readonly settings: HostedSettings;
  readonly db: Db;
  readonly now: () => number;
  readonly log?: (entry: ModelCapLogEntry) => void;
  /** Bets waiting for a verdict now, and a way to run them (verdicts go first after the reset). */
  readonly waitingVerdicts?: () => number;
  readonly runWaitingVerdicts?: () => void;
}

export interface SelectOptions {
  /**
   * `SIB_FAKE_MODEL=1`: the recorded-fixture model, for CI, tests and `npm run dev` only. It is
   * never chosen for any other reason, so fixtures can not pose as Gemma by accident.
   */
  readonly useFake: boolean;
  /** Builds the fake model; only called when `useFake` is true. */
  readonly fake: () => ModelClient;
  /**
   * Flag `finetunedBookmaker`: the bookmaker job uses the model at `models.e4b-ft` when the
   * config has one (REQ-019). Every other job keeps the primary model. Ignored on the fake model.
   */
  readonly finetunedBookmaker?: boolean;
  /** Flag `voice`: also set up the llama.cpp audio client (REQ-027). Ignored on the fake model. */
  readonly voice?: boolean;
  /**
   * Hosted mode: the DigitalOcean client with the daily cap replaces Ollama (and the fine-tuned
   * bookmaker and voice, which are off there). `useFake` still wins, for tests and the demo.
   */
  readonly hosted?: HostedModelOptions;
  readonly fetch?: typeof fetch;
  /** The environment the proxy check reads (`NODE_USE_ENV_PROXY`, `NO_PROXY`); `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
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
  if (options.hosted !== undefined) {
    return selectHosted(options.hosted, options.fetch);
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
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const health = await client.health();
  const where = `${tag} on Ollama at ${config.ollama.baseUrl}`;
  const finetuned =
    options.finetunedBookmaker === true ? await setUpFinetuned(config, options) : undefined;
  const voice = options.voice === true ? await setUpVoice(config, options) : undefined;
  const notices = [
    health.state === "offline"
      ? `Gemma: ${where} is not usable yet (${health.detail ?? "no answer"}). Cards show rule odds and "Gemma offline" until it is; settlements wait.`
      : `Gemma: ${where}, loading it now (keep_alive ${String(config.ollama.keepAlive)}).`,
    ...(finetuned === undefined ? [] : [finetuned.notice]),
    ...(voice === undefined ? [] : [voice.notice]),
  ];
  return {
    model: client,
    mode: "ollama",
    jobModels: {
      ...(finetuned?.client === undefined ? {} : { bookmaker: finetuned.client }),
      ...(voice === undefined ? {} : { [LISTENER_AUDIO_JOB]: voice.client }),
    },
    notice: notices.join("\n"),
    // Both models are loaded with `keep_alive` (one after the other, never both at once) so the
    // first bookmaker call does not wait for the fine-tuned weights either.
    warmUp: async () => {
      const primary = await client.warmUp();
      const bookmaker = finetuned?.client;
      if (bookmaker === undefined) {
        return primary;
      }
      const loaded = await bookmaker.warmUp();
      return loaded.state === "offline"
        ? {
            ...primary,
            detail: `${primary.detail ?? primary.state}; fine-tuned bookmaker: ${loaded.detail ?? "offline"}`,
          }
        : primary;
    },
  };
}

/**
 * Hosted mode (REQ-032): `DigitalOceanClient` behind the daily cap. No Ollama tag is needed and
 * none is read. The notice names the host and the model, never the key. An unreachable service
 * does not stop the start: Gemma shows offline until it answers, as in home mode.
 */
async function selectHosted(
  hosted: HostedModelOptions,
  fetchImpl: typeof fetch | undefined,
): Promise<ModelSelection> {
  const { settings } = hosted;
  const client = new DigitalOceanClient({
    model: settings.model,
    apiKey: settings.inferenceKey,
    vision: settings.vision,
    toolUse: settings.toolUse,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  const capped = new CappedModelClient(client, {
    db: hosted.db,
    now: hosted.now,
    cap: settings.dailyModelCalls,
    ...(hosted.log === undefined ? {} : { log: hosted.log }),
    ...(hosted.waitingVerdicts === undefined ? {} : { waitingVerdicts: hosted.waitingVerdicts }),
    ...(hosted.runWaitingVerdicts === undefined
      ? {}
      : { runWaitingVerdicts: hosted.runWaitingVerdicts }),
  });
  const health = await capped.health();
  const where = `${settings.model} on DigitalOcean inference (${DIGITALOCEAN_INFERENCE_URL})`;
  return {
    model: capped,
    mode: "digitalocean",
    jobModels: {},
    notice: [
      health.state === "offline"
        ? `Gemma: ${where} is not usable yet (${health.detail ?? "no answer"}). Cards show rule odds and "Gemma offline" until it is; settlements wait.`
        : `Gemma: ${where}.`,
      `Hosted mode: ${settings.dailyModelCalls} model calls a day, tool use ${settings.toolUse}, photos ${settings.vision ? "are sent to DigitalOcean (SIB_DO_VISION=1)" : "stay on this server"}.`,
    ].join("\n"),
    warmUp: () => capped.health(),
  };
}

/**
 * The fine-tuned bookmaker (flag `finetunedBookmaker`): a second Ollama client on the tag at
 * `models.e4b-ft`. With no such entry nothing changes, and the notice says why.
 */
async function setUpFinetuned(
  config: ModelsConfig,
  options: SelectOptions,
): Promise<{ client: OllamaClient | undefined; notice: string }> {
  const tag = finetunedModelTag(config);
  if (tag === undefined) {
    return {
      client: undefined,
      notice: `Fine-tuned bookmaker: the flag is on but config/models.json has no models.${FINETUNED_MODEL_KEY}.tag, so the bookmaker uses ${primaryModelTag(config) ?? "the primary model"}.`,
    };
  }
  const client = new OllamaClient({
    baseUrl: config.ollama.baseUrl,
    model: tag,
    keepAlive: config.ollama.keepAlive,
    temperature: config.ollama.temperature,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  // Learns the digest, so each bet it prices records the exact model version (AC-019.4).
  const health = await client.health();
  return {
    client,
    notice:
      health.state === "offline"
        ? `Fine-tuned bookmaker: ${tag} is not usable yet (${health.detail ?? "no answer"}). Cards show rule odds until it is.`
        : `Fine-tuned bookmaker: ${tag} prices the cards; every other job stays on the primary model.`,
  };
}

/** The voice job's runtime (flag `voice`): llama.cpp on 127.0.0.1, which may start after the app. */
async function setUpVoice(
  config: ModelsConfig,
  options: SelectOptions,
): Promise<{ client: ModelClient; notice: string }> {
  const client = new LlamaCppAudioClient({
    baseUrl: config.llamaCpp.baseUrl,
    model: config.llamaCpp.model,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.env === undefined ? {} : { env: options.env }),
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
