import type { z } from "zod";

import { logDecision } from "../ledger/decisions.js";
import type { Db } from "../db.js";
import {
  ModelTimeoutError,
  ModelUnavailableError,
  type ChatMessage,
  type ChatResponse,
  type ModelClient,
  type ToolCall,
  type ToolDefinition,
} from "../model/client.js";

import { jobJsonSchema } from "./json-schema.js";
import type { Prompt } from "./prompts.js";

/** 30 s per model call (requirements.md, fixed values). */
export const MODEL_CALL_TIMEOUT_MS = 30_000;
/** 45 s per Gemma job, measured from when it was queued, so GPU queue time counts. */
export const JOB_DEADLINE_MS = 45_000;
/** At most 4 model calls per job: 2 for the first attempt and 2 for its single retry. */
export const MAX_MODEL_CALLS = 4;
/** A job may call its tool at most twice (design.md, Interfaces: one read-only tool). */
export const MAX_TOOL_CALLS = 2;

/** How the tool was used in the decision that was logged (design.md, `gemma_decisions`). */
export type ToolMode = "called" | "injected" | "missed";

/**
 * `native`: Gemma calls the tool. `injected`: the app makes the call itself and hands Gemma the
 * result in the conversation (the T-001 fallback when tool calling fails on the runtime); Gemma
 * still decides.
 */
export type ToolUseMode = "native" | "injected";

/**
 * `single_call`: the tool and the answer schema go with the first call. `two_step`: the first call
 * has the tool only and the schema comes with the answer call (T-001 fallback when a runtime
 * cannot combine tools with a JSON schema).
 */
export type AnswerMode = "single_call" | "two_step";

export interface JobTool {
  readonly definition: ToolDefinition;
  /**
   * Runs one call. The arguments are model output and untrusted: validate them. Returns the text
   * the model reads as the tool result. Throws `JobToolError` when the tool cannot work at all.
   */
  execute(args: Readonly<Record<string, unknown>>): Promise<string>;
  /** An answer without a call is retried once and then fails (AC-003.6). */
  readonly required: boolean;
  /** Arguments of the app-made call in injected mode. */
  readonly injectedArguments: Readonly<Record<string, unknown>>;
}

/** The tool could not run (the forecast is unavailable); a retry would not help. */
export class JobToolError extends Error {
  override readonly name = "JobToolError";
}

export interface JobRequest<T> {
  readonly job: string;
  readonly prompt: Prompt;
  /** The user message: untrusted input inside delimiters (design.md, Gemma jobs). */
  readonly user: string;
  readonly images?: readonly Uint8Array[];
  /** The job's output schema; the JSON schema sent to the runtime is derived from it. */
  readonly schema: z.ZodType<T>;
  /** Rules the schema cannot express (AC-004.3). Returns what to tell the model, else undefined. */
  readonly check?: (output: T) => string | undefined;
  readonly tool?: JobTool;
  readonly cardId?: number;
  readonly betId?: number;
  readonly photoId?: string;
  /** Free of household text and photo data: it is stored with the decision (NFR-007). */
  readonly inputSummary: string;
  /** Queue time to measure the deadline from; a photo's inspector and bookmaker share one. */
  readonly enqueuedAt?: number;
}

export type JobFailure =
  "unavailable" | "timeout" | "deadline" | "invalid" | "tool_missed" | "tool_error";

interface JobFacts {
  /** Id of the `gemma_decisions` row written for this job. */
  readonly decisionId: number;
  readonly model: string;
  readonly modelDigest: string | undefined;
  readonly promptVersion: string;
  readonly toolMode: ToolMode | undefined;
  /** 0 or 1: whether the single retry was used. */
  readonly retries: number;
  /** Model calls made, at most `MAX_MODEL_CALLS`. */
  readonly calls: number;
  /** Time spent running, without the wait in the queue. */
  readonly latencyMs: number;
  /** Time from enqueue to the end, queue wait included. */
  readonly totalMs: number;
}

export type JobResult<T> =
  | (JobFacts & { readonly ok: true; readonly output: T; readonly raw: string })
  | (JobFacts & {
      readonly ok: false;
      readonly failure: JobFailure;
      readonly error: string;
      readonly raw: string | undefined;
    });

export interface RunnerOptions {
  readonly model: ModelClient;
  readonly db: Db;
  readonly now: () => number;
  readonly callTimeoutMs?: number;
  readonly deadlineMs?: number;
  readonly toolUse?: ToolUseMode;
  readonly answerMode?: AnswerMode;
}

/** A line for the structured JSON log of one finished job (NFR-007): ids and numbers only. */
export interface JobLogEntry {
  readonly job: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly toolMode: ToolMode | null;
  readonly cardId: number | null;
  readonly betId: number | null;
  readonly decisionId: number;
  readonly latencyMs: number;
  readonly totalMs: number;
  readonly valid: boolean;
  readonly retries: number;
  readonly calls: number;
  readonly failure: JobFailure | null;
}

/** How long a runtime that ignores `timeoutMs` is still waited for, as a backstop. */
const BACKSTOP_GRACE_MS = 100;

function summariseIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? "answer" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ")
    .slice(0, 400);
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ModelTimeoutError(`No answer within ${ms} ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

class Stop extends Error {
  constructor(
    readonly failure: JobFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs Gemma jobs (design.md, Gemma jobs): one at a time through a FIFO queue, each with a
 * deadline measured from enqueue, a schema-validated answer, one retry that tells the model what
 * was wrong, a tool loop of at most two tool calls and at most four model calls in all. Every job
 * writes one row to `gemma_decisions`.
 */
export class JobRunner {
  private readonly model: ModelClient;
  private readonly db: Db;
  private readonly now: () => number;
  private readonly callTimeoutMs: number;
  private readonly deadlineMs: number;
  private readonly toolUse: ToolUseMode;
  private readonly answerMode: AnswerMode;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private runs = 0;
  private log: (entry: JobLogEntry) => void = () => undefined;

  constructor(options: RunnerOptions) {
    this.model = options.model;
    this.db = options.db;
    this.now = options.now;
    this.callTimeoutMs = options.callTimeoutMs ?? MODEL_CALL_TIMEOUT_MS;
    this.deadlineMs = options.deadlineMs ?? JOB_DEADLINE_MS;
    this.toolUse = options.toolUse ?? "native";
    this.answerMode = options.answerMode ?? "single_call";
  }

  /** Where finished jobs are logged; the app wires its pino logger here. */
  setLogger(log: (entry: JobLogEntry) => void): void {
    this.log = log;
  }

  /** Jobs queued or running. */
  get queued(): number {
    return this.pending;
  }

  /** Resolves when no job is queued or running (tests and a clean shutdown). */
  async idle(): Promise<void> {
    while (this.pending > 0) {
      await this.tail;
    }
  }

  /** Queues a job; the deadline starts now unless the request says otherwise. */
  run<T>(request: JobRequest<T>): Promise<JobResult<T>> {
    const enqueuedAt = request.enqueuedAt ?? this.now();
    this.pending += 1;
    const result = this.tail.then(() => this.execute(request, enqueuedAt));
    this.tail = result.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
    return result;
  }

  private async execute<T>(request: JobRequest<T>, enqueuedAt: number): Promise<JobResult<T>> {
    const started = performance.now();
    this.runs += 1;
    const run = this.runs;
    const deadlineAt = enqueuedAt + this.deadlineMs;
    const state = {
      calls: 0,
      toolCalls: 0,
      retries: 0,
      model: "unknown",
      modelDigest: undefined as string | undefined,
      toolMode: undefined as ToolMode | undefined,
      note: undefined as string | undefined,
      injectedResult: undefined as string | undefined,
    };

    const call = async (
      messages: readonly ChatMessage[],
      withTools: boolean,
      withSchema: boolean,
    ): Promise<ChatResponse> => {
      if (state.calls >= MAX_MODEL_CALLS) {
        throw new Stop("invalid", "The retry budget of 4 model calls is used up");
      }
      const remaining = deadlineAt - this.now();
      if (remaining <= 0) {
        throw new Stop("deadline", "The 45 s job deadline passed");
      }
      const timeoutMs = Math.min(this.callTimeoutMs, remaining);
      state.calls += 1;
      try {
        const response = await raceTimeout(
          this.model.chat({
            job: request.job,
            run,
            messages,
            ...(request.images === undefined ? {} : { images: request.images }),
            ...(withTools && request.tool !== undefined
              ? { tools: [request.tool.definition] }
              : {}),
            ...(withSchema ? { schema: jobJsonSchema(request.schema) } : {}),
            timeoutMs,
          }),
          timeoutMs + BACKSTOP_GRACE_MS,
        );
        state.model = response.model;
        state.modelDigest = response.modelDigest;
        return response;
      } catch (error) {
        if (error instanceof ModelTimeoutError) {
          throw new Stop(timeoutMs < this.callTimeoutMs ? "deadline" : "timeout", error.message);
        }
        if (error instanceof ModelUnavailableError) {
          throw new Stop("unavailable", error.message);
        }
        throw error;
      }
    };

    const runTool = async (tool: JobTool, toolCall: ToolCall): Promise<string> => {
      if (toolCall.name !== tool.definition.name) {
        return `Unknown tool ${toolCall.name}. The only tool is ${tool.definition.name}.`;
      }
      if (state.toolCalls >= MAX_TOOL_CALLS) {
        return `Too many tool calls: at most ${MAX_TOOL_CALLS} per job. Answer with what you have.`;
      }
      state.toolCalls += 1;
      const remaining = deadlineAt - this.now();
      if (remaining <= 0) {
        throw new Stop("deadline", "The 45 s job deadline passed");
      }
      try {
        return await raceTimeout(tool.execute(toolCall.arguments), remaining);
      } catch (error) {
        if (error instanceof ModelTimeoutError) {
          throw new Stop("deadline", "The 45 s job deadline passed during a tool call");
        }
        if (error instanceof JobToolError) {
          throw new Stop("tool_error", error.message);
        }
        throw error;
      }
    };

    /** Returns the text of an answer, or a problem to put in front of the model on the retry. */
    const attempt = async (
      base: readonly ChatMessage[],
    ): Promise<{ answer: string } | { problem: string; failure: JobFailure; raw?: string }> => {
      const tool = request.tool;
      if (tool === undefined) {
        return { answer: (await call(base, false, true)).content };
      }
      if (this.toolUse === "injected") {
        // The app makes the call and passes the result as the tool result (T-001 fallback).
        state.injectedResult ??= await runTool(tool, {
          name: tool.definition.name,
          arguments: tool.injectedArguments,
        });
        state.toolMode = "injected";
        const messages: ChatMessage[] = [
          ...base,
          {
            role: "assistant",
            content: "",
            toolCalls: [{ name: tool.definition.name, arguments: tool.injectedArguments }],
          },
          { role: "tool", content: state.injectedResult, toolName: tool.definition.name },
        ];
        return { answer: (await call(messages, false, true)).content };
      }

      const first = await call(base, true, this.answerMode === "single_call");
      if (first.toolCalls.length === 0) {
        if (tool.required) {
          state.toolMode = "missed";
          return {
            problem: `You must call the ${tool.definition.name} tool before you answer. Call it now.`,
            failure: "tool_missed",
            raw: first.content,
          };
        }
        return { answer: first.content };
      }
      state.toolMode = "called";
      const messages: ChatMessage[] = [
        ...base,
        { role: "assistant", content: first.content, toolCalls: first.toolCalls },
      ];
      for (const toolCall of first.toolCalls) {
        messages.push({
          role: "tool",
          content: await runTool(tool, toolCall),
          toolName: toolCall.name,
        });
      }
      return { answer: (await call(messages, false, true)).content };
    };

    const base: ChatMessage[] = [
      { role: "system", content: request.prompt.text },
      { role: "user", content: request.user },
    ];

    let outcome:
      | { ok: true; output: T; raw: string }
      | { ok: false; failure: JobFailure; error: string; raw: string | undefined };
    try {
      outcome = await this.attempts(request, base, state, attempt);
    } catch (error) {
      if (error instanceof Stop) {
        outcome = { ok: false, failure: error.failure, error: error.message, raw: undefined };
      } else {
        throw error;
      }
    }

    const finished = this.now();
    const latencyMs = Math.round(performance.now() - started);
    const retries = state.retries;
    const decisionId = logDecision(this.db, {
      job: request.job,
      cardId: request.cardId ?? null,
      betId: request.betId ?? null,
      photoId: request.photoId ?? null,
      model: state.model,
      modelDigest: state.modelDigest,
      promptVersion: request.prompt.version,
      toolMode: state.toolMode,
      inputSummary: request.inputSummary,
      output: outcome.raw,
      valid: outcome.ok,
      retries,
      latencyMs,
      error: outcome.ok ? state.note : `${outcome.failure}: ${outcome.error}`,
      createdAt: finished,
    });
    const facts: JobFacts = {
      decisionId,
      model: state.model,
      modelDigest: state.modelDigest,
      promptVersion: request.prompt.version,
      toolMode: state.toolMode,
      retries,
      calls: state.calls,
      latencyMs,
      totalMs: Math.max(0, finished - enqueuedAt),
    };
    this.log({
      job: request.job,
      model: state.model,
      promptVersion: request.prompt.version,
      toolMode: state.toolMode ?? null,
      cardId: request.cardId ?? null,
      betId: request.betId ?? null,
      decisionId,
      latencyMs,
      totalMs: facts.totalMs,
      valid: outcome.ok,
      retries,
      calls: state.calls,
      failure: outcome.ok ? null : outcome.failure,
    });
    return outcome.ok ? { ...facts, ...outcome } : { ...facts, ...outcome };
  }

  /** The first attempt and, when its answer is unusable, the single retry. */
  private async attempts<T>(
    request: JobRequest<T>,
    base: readonly ChatMessage[],
    state: { retries: number; note: string | undefined },
    attempt: (
      messages: readonly ChatMessage[],
    ) => Promise<{ answer: string } | { problem: string; failure: JobFailure; raw?: string }>,
  ): Promise<
    | { ok: true; output: T; raw: string }
    | { ok: false; failure: JobFailure; error: string; raw: string | undefined }
  > {
    let messages = base;
    let last: { failure: JobFailure; error: string; raw: string | undefined } | undefined;
    for (let round = 0; round < 2; round += 1) {
      if (round === 1) {
        state.retries = 1;
        state.note = `retry after: ${last?.error ?? "unknown"}`.slice(0, 300);
        messages = [
          ...base,
          {
            role: "user",
            content: `Your previous answer was rejected: ${last?.error ?? "unknown"}. Answer again and fix this.`,
          },
        ];
      }
      const result = await attempt(messages);
      if ("problem" in result) {
        last = { failure: result.failure, error: result.problem, raw: result.raw };
        continue;
      }
      const checked = this.validate(request, result.answer);
      if (checked.ok) {
        return { ok: true, output: checked.output, raw: result.answer };
      }
      last = { failure: "invalid", error: checked.error, raw: result.answer };
    }
    state.note = undefined;
    return {
      ok: false,
      failure: last?.failure ?? "invalid",
      error: last?.error ?? "unknown",
      raw: last?.raw,
    };
  }

  private validate<T>(
    request: JobRequest<T>,
    answer: string,
  ): { ok: true; output: T } | { ok: false; error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer);
    } catch {
      return { ok: false, error: "The answer is not valid JSON" };
    }
    const result = request.schema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: summariseIssues(result.error) };
    }
    const problem = request.check?.(result.data);
    if (problem !== undefined) {
      return { ok: false, error: problem };
    }
    return { ok: true, output: result.data };
  }
}
