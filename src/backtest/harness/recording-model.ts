import type {
  ChatRequest,
  ChatResponse,
  ModelClient,
  ModelHealth,
} from "../../server/model/client.js";

/** One model call as the harness saw it. */
export interface RecordedCall {
  readonly toolsOffered: boolean;
  readonly toolCalls: number;
}

/**
 * Wraps a `ModelClient` and remembers what each call returned, so the harness can tell whether the
 * model's first answer came without a `get_forecast` call even when the retry later fixed it
 * (the runner's `tool_mode` only keeps the last attempt). Calls that fail are not recorded.
 */
export class RecordingModelClient implements ModelClient {
  private calls: RecordedCall[] = [];

  constructor(private readonly inner: ModelClient) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.inner.chat(request);
    this.calls.push({
      toolsOffered: (request.tools?.length ?? 0) > 0,
      toolCalls: response.toolCalls.length,
    });
    return response;
  }

  health(): Promise<ModelHealth> {
    return this.inner.health();
  }

  /** Unloads the model from the GPU when the runtime can; never throws. */
  async unload(): Promise<void> {
    await this.inner.unload?.();
  }

  /** The calls since the last `take`, oldest first. */
  take(): RecordedCall[] {
    const taken = this.calls;
    this.calls = [];
    return taken;
  }
}
