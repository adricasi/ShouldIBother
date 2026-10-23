import {
  ModelTimeoutError,
  ModelUnavailableError,
  type ChatRequest,
  type ChatResponse,
  type ModelClient,
  type ModelHealth,
  type ToolCall,
} from "../server/model/client.js";

/** One model call as the eval saw it: what came back, or how it failed. */
export interface LoggedCall {
  readonly job: string;
  readonly toolsOffered: boolean;
  readonly images: number;
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly model: string | undefined;
  readonly modelDigest: string | undefined;
  readonly error: "timeout" | "unavailable" | undefined;
  readonly ms: number;
}

/**
 * Wraps the model the eval runs against and remembers every call, failures included. The eval
 * needs it for the number of model calls of a case (the judge does not report it), whether the
 * first answer came with a tool call, and the raw answers for `--record-fixtures`.
 */
export class CallLog implements ModelClient {
  private calls: LoggedCall[] = [];

  constructor(private readonly inner: ModelClient) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = performance.now();
    const entry = {
      job: request.job,
      toolsOffered: (request.tools?.length ?? 0) > 0,
      images: request.images?.length ?? 0,
    };
    try {
      const response = await this.inner.chat(request);
      this.calls.push({
        ...entry,
        content: response.content,
        toolCalls: response.toolCalls,
        model: response.model,
        modelDigest: response.modelDigest,
        error: undefined,
        ms: Math.round(performance.now() - started),
      });
      return response;
    } catch (error) {
      this.calls.push({
        ...entry,
        content: "",
        toolCalls: [],
        model: undefined,
        modelDigest: undefined,
        error:
          error instanceof ModelTimeoutError
            ? "timeout"
            : error instanceof ModelUnavailableError
              ? "unavailable"
              : undefined,
        ms: Math.round(performance.now() - started),
      });
      throw error;
    }
  }

  health(): Promise<ModelHealth> {
    return this.inner.health();
  }

  async unload(): Promise<void> {
    await this.inner.unload?.();
  }

  /** The calls since the last `take`, oldest first. */
  take(): LoggedCall[] {
    const taken = this.calls;
    this.calls = [];
    return taken;
  }
}
