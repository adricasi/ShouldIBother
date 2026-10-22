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

export interface OllamaOptions {
  /** `http://127.0.0.1:11434`; `config/models.json` only allows loopback addresses. */
  readonly baseUrl: string;
  /** Ollama tag of the model, e.g. `gemma4:e4b` (from `config/models.json`). */
  readonly model: string;
  /** How long Ollama keeps the model loaded after a call. */
  readonly keepAlive: string | number;
  readonly temperature?: number;
  /** A health check that takes longer than this is "offline". */
  readonly healthTimeoutMs?: number;
  /** The warm-up may have to load the weights from disk. */
  readonly warmUpTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_WARM_UP_TIMEOUT_MS = 120_000;

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
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
  private warming = false;

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.settings = {
      model: options.model,
      keepAlive: options.keepAlive,
      temperature: options.temperature ?? 0,
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
      payload = await response.json();
    } catch (error) {
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

  async chat(request: ChatRequest): Promise<ChatResponse> {
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
    const digest = await this.modelDigest();
    return {
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      model: parsed.model ?? this.settings.model,
      ...(digest === undefined ? {} : { modelDigest: digest }),
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

  /** Digest of the model as Ollama lists it, looked up once and then remembered. */
  private async modelDigest(): Promise<string | undefined> {
    if (this.digest === undefined) {
      const listed = await this.listModels();
      this.digest = listed?.find((entry) => entry.name === this.settings.model)?.digest;
    }
    return this.digest;
  }

  async health(): Promise<ModelHealth> {
    const listed = await this.listModels();
    if (listed === undefined) {
      return { state: "offline", detail: "Ollama is not answering" };
    }
    const entry = listed.find((model) => model.name === this.settings.model);
    if (entry === undefined) {
      return { state: "offline", detail: `model ${this.settings.model} is not pulled` };
    }
    this.digest ??= entry.digest;
    return this.warming
      ? { state: "waking", detail: "loading the model" }
      : { state: "online", detail: this.settings.model };
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
