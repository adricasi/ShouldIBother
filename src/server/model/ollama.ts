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
  TAGS_PATH,
  buildChatBody,
  buildLoadBody,
  parseChatResponse,
  parseErrorText,
  parseTags,
  type ListedModel,
  type WireSettings,
} from "./ollama-wire.js";
import { NonLoopbackRuntimeError, loopbackOrigin } from "./loopback.js";
import { assertNoProxyForLoopback } from "./proxy-guard.js";
import { MAX_RESPONSE_BYTES, isTimeout, readLimited } from "./http.js";

export { MAX_RESPONSE_BYTES };

export interface OllamaOptions {
  /** `http://127.0.0.1:11434`; `config/models.json` only allows loopback addresses. */
  readonly baseUrl: string;
  /** Ollama tag of the model, e.g. `gemma4:e4b` (from `config/models.json`). */
  readonly model: string;
  /** How long Ollama keeps the model loaded after a call. */
  readonly keepAlive: string | number;
  readonly temperature?: number;
  /** Fixed sampling seed, sent as the `seed` option; unset in the live app, set by the backtest. */
  readonly seed?: number;
  /** A health check that takes longer than this is "offline". */
  readonly healthTimeoutMs?: number;
  /** The warm-up may have to load the weights from disk. */
  readonly warmUpTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** The environment the proxy check reads; `process.env` unless a test says otherwise. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_WARM_UP_TIMEOUT_MS = 120_000;

/** `gemma4` and `gemma4:latest` are the same model in Ollama's listings. */
function normaliseTag(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/**
 * `ModelClient` for Gemma on Ollama (ADR-0004), over Ollama's HTTP API on 127.0.0.1. The wire
 * format is in `ollama-wire.ts` and is UNVERIFIED until T-010 runs it against a real Ollama.
 * Per-call timeout via `AbortSignal.timeout`; a runtime that does not answer or refuses is
 * `ModelUnavailableError` (Gemma offline, AC-013.3).
 */
export class OllamaClient implements ModelClient {
  private readonly settings: WireSettings;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly healthTimeoutMs: number;
  private readonly warmUpTimeoutMs: number;
  private digest: string | undefined;
  /** True once the model list was read successfully, so a model without a digest is not asked again. */
  private digestLookedUp = false;
  private warming = false;

  constructor(options: OllamaOptions) {
    // Checked again here, not only at config load: Ollama stays on this laptop (NFR-001).
    if (loopbackOrigin(options.baseUrl) === undefined) {
      throw new NonLoopbackRuntimeError(
        `Ollama must be an http URL on 127.0.0.1 or [::1], got ${JSON.stringify(options.baseUrl)}`,
      );
    }
    // The global fetch may be routed through an environment proxy; a client given its own fetch
    // (tests) is not.
    if (options.fetch === undefined) {
      assertNoProxyForLoopback("Ollama", options.env);
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.settings = {
      model: options.model,
      keepAlive: options.keepAlive,
      temperature: options.temperature ?? 0,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    };
    this.fetchImpl = options.fetch ?? fetch;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.warmUpTimeoutMs = options.warmUpTimeoutMs ?? DEFAULT_WARM_UP_TIMEOUT_MS;
  }

  /** One JSON request; maps transport failures to the two errors the jobs understand. */
  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        // A redirect would leave 127.0.0.1: refuse it.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new ModelTimeoutError(`Ollama did not answer within ${timeoutMs} ms`);
      }
      throw new ModelUnavailableError("Ollama is not reachable on 127.0.0.1", { cause: error });
    }
    let payload: unknown;
    try {
      const text = await readLimited(response, MAX_RESPONSE_BYTES, "Ollama");
      payload = text === "" ? undefined : JSON.parse(text);
    } catch (error) {
      if (error instanceof ModelUnavailableError) {
        throw error;
      }
      if (isTimeout(error)) {
        throw new ModelTimeoutError(`Ollama did not finish within ${timeoutMs} ms`);
      }
      payload = undefined;
    }
    if (!response.ok) {
      const text = parseErrorText(payload);
      throw new ModelUnavailableError(
        `Ollama answered ${response.status}${text === undefined ? "" : `: ${text}`}`,
      );
    }
    return payload;
  }

  /**
   * Learns the digest when it is not known yet (Ollama started after the app, so the start-up
   * health check found nothing): a bet records `tag@digest` (AC-019.4). One short list call, only
   * while the digest is missing and the list has not been read; never throws.
   */
  private async ensureDigest(): Promise<void> {
    if ((this.digest !== undefined && this.digest !== "") || this.digestLookedUp) {
      return;
    }
    const listed = await this.listModels();
    if (listed === undefined) {
      return;
    }
    this.digestLookedUp = true;
    const wanted = normaliseTag(this.settings.model);
    const digest = listed.find((model) => normaliseTag(model.name) === wanted)?.digest;
    if (digest !== undefined && digest !== "") {
      this.digest = digest;
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    await this.ensureDigest();
    const payload = await this.request(
      "POST",
      CHAT_PATH,
      buildChatBody(request, this.settings),
      request.timeoutMs,
    );
    const parsed = parseChatResponse(payload);
    if (parsed === undefined) {
      throw new ModelUnavailableError("Ollama sent an answer this app cannot read");
    }
    // The digest comes from the health check, the warm-up or, while still unknown, the lookup
    // above (which has its own short timeout).
    return {
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      model: parsed.model ?? this.settings.model,
      ...(this.digest === undefined ? {} : { modelDigest: this.digest }),
    };
  }

  /** The models Ollama has, or undefined when it does not answer. */
  private async listModels(): Promise<ListedModel[] | undefined> {
    try {
      return parseTags(await this.request("GET", TAGS_PATH, undefined, this.healthTimeoutMs));
    } catch {
      return undefined;
    }
  }

  async health(): Promise<ModelHealth> {
    const listed = await this.listModels();
    if (listed === undefined) {
      return { state: "offline", detail: "Ollama is not answering" };
    }
    const wanted = normaliseTag(this.settings.model);
    const entry = listed.find((model) => normaliseTag(model.name) === wanted);
    if (entry === undefined) {
      return { state: "offline", detail: `model ${this.settings.model} is not pulled` };
    }
    this.digestLookedUp = true;
    if (entry.digest !== undefined && entry.digest !== "") {
      this.digest = entry.digest;
    }
    return this.warming
      ? { state: "waking", detail: "loading the model" }
      : { state: "online", detail: this.settings.model };
  }

  /** Unloads the model (`keep_alive: 0`) so the GPU is free; never throws. */
  async unload(): Promise<void> {
    try {
      await this.request(
        "POST",
        CHAT_PATH,
        buildLoadBody({ ...this.settings, keepAlive: 0 }),
        Math.max(this.healthTimeoutMs, 10_000),
      );
    } catch {
      // Best effort: Ollama unloads the model after its keep_alive anyway.
    }
  }

  /**
   * Loads the model into memory with `keep_alive` so the first card does not wait for it
   * (design.md, GPU and model residency). Status is "waking" while it runs. Never throws.
   */
  async warmUp(): Promise<ModelHealth> {
    this.warming = true;
    try {
      await this.request("POST", CHAT_PATH, buildLoadBody(this.settings), this.warmUpTimeoutMs);
    } catch (error) {
      this.warming = false;
      return {
        state: "offline",
        detail: error instanceof Error ? error.message : "warm-up failed",
      };
    }
    this.warming = false;
    return this.health();
  }
}
