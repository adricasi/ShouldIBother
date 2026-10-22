/** A message in a model conversation. Tool results go back as `tool` messages. */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** On an assistant message: the tool calls it made, so the tool loop can be replayed. */
  readonly toolCalls?: readonly ToolCall[];
  /** On a tool message: the name of the tool whose result this is. */
  readonly toolName?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON schema of the tool's arguments. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ChatRequest {
  /** The Gemma job asking (judge, bookmaker, ...). The fake picks its fixture folder from it. */
  readonly job: string;
  readonly messages: readonly ChatMessage[];
  readonly images?: readonly Uint8Array[];
  readonly tools?: readonly ToolDefinition[];
  /** JSON schema of the answer, derived from the job's zod schema. */
  readonly schema?: Readonly<Record<string, unknown>>;
  /** Per-call timeout; 30 s for Gemma calls (requirements.md, fixed values). */
  readonly timeoutMs: number;
}

export interface ChatResponse {
  /** The model's answer text; JSON for a job that sends a schema. */
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  /** Model name and digest as the runtime reports them, recorded per decision (REQ-028). */
  readonly model: string;
  readonly modelDigest?: string;
}

/** The model runtime is not running or refused the call (Gemma offline). */
export class ModelUnavailableError extends Error {
  override readonly name = "ModelUnavailableError";
}

/** The call did not answer within `timeoutMs`. */
export class ModelTimeoutError extends Error {
  override readonly name = "ModelTimeoutError";
}

/**
 * The seam between the jobs and the runtime (design.md, ModelClient). Implementations: Ollama and
 * llama.cpp (T-010), and `FakeModelClient`, which CI uses.
 */
export interface ModelClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
}
