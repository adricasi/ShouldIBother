import type { Secret, ToolUse } from "../mode.js";

import {
  ModelTimeoutError,
  ModelUnavailableError,
  type ChatRequest,
  type ChatResponse,
  type ModelClient,
  type ModelHealth,
} from "./client.js";
import {
  CHAT_PATH,
  MODELS_PATH,
  buildChatBody,
  parseChatResponse,
  parseErrorCode,
  parseModelIds,
  type WireSettings,
} from "./digitalocean-wire.js";
import { MAX_RESPONSE_BYTES, isTimeout, readLimited } from "./http.js";

/**
 * UNVERIFIED (T-040): DigitalOcean's Serverless Inference endpoint, written from its public
 * documentation without access to it. The builder checks it with `GET /v1/models` before the
 * first deploy (docs/deploy-digitalocean.md) and changes this one constant if it is wrong; the
 * allowlist below follows it.
 */
export const DIGITALOCEAN_INFERENCE_URL = "https://inference.do-ai.run";

/** The one host hosted mode may call for Gemma (AC-032.2); Open-Meteo has its own list. */
export const DIGITALOCEAN_ALLOWED_HOSTS: readonly string[] = [
  new URL(DIGITALOCEAN_INFERENCE_URL).hostname,
];

/** A request would leave for a host that is not the inference API; nothing was sent. */
export class DisallowedInferenceHostError extends Error {
  override readonly name = "DisallowedInferenceHostError";
  constructor(host: string) {
    super(`refusing to call host "${host}": not the DigitalOcean inference host`);
  }
}

/**
 * Throws unless `url` is https, names no credentials or port and its host is on the allowlist.
 * Checked when the client is built and again before every request.
 */
export function assertInferenceUrl(
  url: string,
  allowedHosts: readonly string[] = DIGITALOCEAN_ALLOWED_HOSTS,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DisallowedInferenceHostError("(not a URL)");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    !allowedHosts.includes(parsed.hostname)
  ) {
    throw new DisallowedInferenceHostError(parsed.host);
  }
}

export interface DigitalOceanOptions {
  /** The model ID (`SIB_DO_MODEL`). */
  readonly model: string;
  /** Sent as the bearer token and nowhere else; redacted from every error message. */
  readonly apiKey: Secret;
  /** `SIB_DO_VISION=1`: photos may be sent. Off, a request with an image is refused unsent. */
  readonly vision: boolean;
  readonly toolUse: ToolUse;
  /** The inference API; the allowlisted constant unless a test names another allowlisted host. */
  readonly baseUrl?: string;
  readonly temperature?: number;
  /** A health check that takes longer than this is "offline". */
  readonly healthTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;

/**
 * `ModelClient` for Gemma on DigitalOcean's Serverless Inference (hosted mode, REQ-032), over the
 * OpenAI-compatible HTTP API. The wire format is in `digitalocean-wire.ts` and is UNVERIFIED.
 * Per-call timeout via `AbortSignal.timeout`; a service that does not answer or refuses is
 * `ModelUnavailableError` (Gemma offline). This client calls the allowlisted inference host
 * only, never follows a redirect, and never lets the key into an error message, a log or a
 * response. The loopback-only Ollama and llama.cpp clients are unchanged.
 */
export class DigitalOceanClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: Secret;
  private readonly settings: WireSettings;
  private readonly vision: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly healthTimeoutMs: number;

  constructor(options: DigitalOceanOptions) {
    const baseUrl = (options.baseUrl ?? DIGITALOCEAN_INFERENCE_URL).replace(/\/+$/, "");
    assertInferenceUrl(baseUrl);
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey;
    this.vision = options.vision;
    this.settings = {
      model: options.model,
      temperature: options.temperature ?? 0,
      toolUse: options.toolUse,
    };
    this.fetchImpl = options.fetch ?? fetch;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

  /** The text with the key replaced; every message that leaves this class goes through it. */
  private safe(text: string): string {
    return this.apiKey.redact(text);
  }

  /** One JSON request; maps transport failures to the two errors the jobs understand. */
  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    assertInferenceUrl(url);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey.reveal()}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A redirect would take the key to another host: refuse it.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new ModelTimeoutError(`DigitalOcean did not answer within ${timeoutMs} ms`);
      }
      // No `cause`: the original error is not needed and must not carry the request along.
      const reason =
        error instanceof Error
          ? error.cause instanceof Error
            ? error.cause.message
            : error.message
          : "failed";
      throw new ModelUnavailableError(
        this.safe(`DigitalOcean is not reachable: ${reason}`.slice(0, 200)),
      );
    }
    let payload: unknown;
    try {
      const text = await readLimited(response, MAX_RESPONSE_BYTES, "DigitalOcean");
      payload = text === "" ? undefined : JSON.parse(text);
    } catch (error) {
      if (error instanceof ModelUnavailableError) {
        throw error;
      }
      if (isTimeout(error)) {
        throw new ModelTimeoutError(`DigitalOcean did not finish within ${timeoutMs} ms`);
      }
      payload = undefined;
    }
    if (!response.ok) {
      throw new ModelUnavailableError(this.describeFailure(response.status, payload));
    }
    return payload;
  }

  private describeFailure(status: number, payload: unknown): string {
    if (status === 401 || status === 403) {
      return `DigitalOcean refused the inference key (HTTP ${status})`;
    }
    if (status === 429) {
      return "DigitalOcean is rate limiting the inference key (HTTP 429)";
    }
    const code = parseErrorCode(payload);
    return this.safe(`DigitalOcean answered ${status}${code === undefined ? "" : ` (${code})`}`);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Household photos and voice notes go to DigitalOcean only when the builder said so.
    if (request.images !== undefined && request.images.length > 0 && !this.vision) {
      throw new ModelUnavailableError("photos are not sent to DigitalOcean (SIB_DO_VISION is 0)");
    }
    if (request.audio !== undefined && request.audio.length > 0) {
      throw new ModelUnavailableError("audio is never sent to DigitalOcean");
    }
    const payload = await this.request(
      "POST",
      CHAT_PATH,
      buildChatBody(request, this.settings),
      request.timeoutMs,
    );
    const parsed = parseChatResponse(payload);
    if (parsed === undefined) {
      throw new ModelUnavailableError("DigitalOcean sent an answer this app cannot read");
    }
    return {
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      model: parsed.model ?? this.settings.model,
    };
  }

  /** The model IDs the service lists, or undefined when it does not answer with a list. */
  async modelIds(): Promise<string[] | undefined> {
    try {
      return parseModelIds(await this.request("GET", MODELS_PATH, undefined, this.healthTimeoutMs));
    } catch {
      return undefined;
    }
  }

  /** A cheap model list: no generation, no cost; offline when it fails or the model is missing. */
  async health(): Promise<ModelHealth> {
    let payload: unknown;
    try {
      payload = await this.request("GET", MODELS_PATH, undefined, this.healthTimeoutMs);
    } catch (error) {
      return {
        state: "offline",
        detail: error instanceof Error ? error.message : "DigitalOcean is not answering",
      };
    }
    const ids = parseModelIds(payload);
    if (ids !== undefined && !ids.includes(this.settings.model)) {
      return {
        state: "offline",
        detail: "DigitalOcean does not list the model in SIB_DO_MODEL",
      };
    }
    return { state: "online", detail: this.settings.model };
  }

  /** Nothing to load on a hosted service: the start-up check is the model list. Never throws. */
  warmUp(): Promise<ModelHealth> {
    return this.health();
  }
}
