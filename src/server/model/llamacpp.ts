import {
  ModelTimeoutError,
  ModelUnavailableError,
  type ChatRequest,
  type ChatResponse,
  type ModelClient,
  type ModelHealth,
} from "./client.js";
import { MAX_RESPONSE_BYTES, isTimeout, readLimited } from "./http.js";
import {
  COMPLETIONS_PATH,
  HEALTH_PATH,
  buildAudioChatBody,
  parseCompletion,
  parseErrorText,
  type AudioWireSettings,
} from "./llamacpp-wire.js";
import { loopbackOrigin } from "./loopback.js";

export interface LlamaCppOptions {
  /** `http://127.0.0.1:8080`; any other host is refused at construction (AC-027.2). */
  readonly baseUrl: string;
  /** Label recorded with each decision (the server serves the one model it was started with). */
  readonly model: string;
  readonly temperature?: number;
  /** A health check that takes longer than this is "offline". */
  readonly healthTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

/** Thrown when the configured address is not on this laptop; a setup error, not a Gemma outage. */
export class NonLoopbackRuntimeError extends Error {
  override readonly name = "NonLoopbackRuntimeError";
}

/**
 * `ModelClient` for Gemma 4 audio on the llama.cpp server (ADR-0004), used only by the voice job
 * (REQ-027). It talks to 127.0.0.1 and nowhere else: a non-loopback `baseUrl` is refused when
 * the client is built, and a redirect is refused when a call is made (AC-027.2). The wire format
 * is in `llamacpp-wire.ts` and is UNVERIFIED until the builder runs it against a real server.
 * Per-call timeout via `AbortSignal.timeout`; the JobRunner adds the job deadline. The audio is
 * sent from memory and never written to disk or logged.
 */
export class LlamaCppAudioClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly settings: AudioWireSettings;
  private readonly fetchImpl: typeof fetch;
  private readonly healthTimeoutMs: number;

  constructor(options: LlamaCppOptions) {
    const origin = loopbackOrigin(options.baseUrl);
    if (origin === undefined) {
      throw new NonLoopbackRuntimeError(
        `llama.cpp must be an http URL on 127.0.0.1 or [::1], got ${JSON.stringify(options.baseUrl)}`,
      );
    }
    this.baseUrl = origin;
    this.settings = { model: options.model, temperature: options.temperature ?? 0 };
    this.fetchImpl = options.fetch ?? fetch;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

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
        throw new ModelTimeoutError(`llama.cpp did not answer within ${timeoutMs} ms`);
      }
      throw new ModelUnavailableError("llama.cpp is not reachable on 127.0.0.1", { cause: error });
    }
    let payload: unknown;
    try {
      const text = await readLimited(response, MAX_RESPONSE_BYTES, "llama.cpp");
      payload = text === "" ? undefined : JSON.parse(text);
    } catch (error) {
      if (error instanceof ModelUnavailableError) {
        throw error;
      }
      if (isTimeout(error)) {
        throw new ModelTimeoutError(`llama.cpp did not finish within ${timeoutMs} ms`);
      }
      payload = undefined;
    }
    if (!response.ok) {
      const text = parseErrorText(payload);
      throw new ModelUnavailableError(
        `llama.cpp answered ${response.status}${text === undefined ? "" : `: ${text}`}`,
      );
    }
    return payload;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (request.tools !== undefined && request.tools.length > 0) {
      throw new Error("The llama.cpp audio client takes no tools");
    }
    const payload = await this.request(
      "POST",
      COMPLETIONS_PATH,
      buildAudioChatBody(request, this.settings),
      request.timeoutMs,
    );
    const parsed = parseCompletion(payload);
    if (parsed === undefined) {
      throw new ModelUnavailableError("llama.cpp sent an answer this app cannot read");
    }
    return {
      content: parsed.content,
      toolCalls: [],
      model: parsed.model ?? this.settings.model,
    };
  }

  async health(): Promise<ModelHealth> {
    try {
      await this.request("GET", HEALTH_PATH, undefined, this.healthTimeoutMs);
      return { state: "online", detail: this.settings.model };
    } catch (error) {
      return {
        state: "offline",
        detail: error instanceof Error ? error.message : "llama.cpp is not answering",
      };
    }
  }
}
