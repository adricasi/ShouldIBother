import { z } from "zod";

import type { ChatMessage, ChatRequest, ToolCall } from "./client.js";

/*
 * UNVERIFIED (T-010): everything in this file is written from Ollama's documented HTTP API
 * (`POST /api/chat`, `GET /api/tags`) without a running Ollama, because the cloud sessions that
 * wrote it cannot reach one. Every endpoint and field name of the wire format lives here and
 * nowhere else; T-010 checks them against the real server on the builder's laptop and fixes
 * only this file. The fake HTTP server in `test/ollama-client.test.ts` speaks the same
 * assumptions, so a correction here is a correction there.
 *
 * Assumed:
 * - Chat: `POST /api/chat` with `{model, messages, tools?, format?, stream: false, keep_alive,
 *   options}`. A message is `{role, content, images?: base64[], tool_calls?: [{function:
 *   {name, arguments}}], tool_name?}`. `format` is a JSON schema object. With `stream: false`
 *   the answer is one object `{model, message: {role, content, tool_calls?}, done}`.
 * - Load without generating: `POST /api/chat` with `messages: []` and `keep_alive`.
 * - Models: `GET /api/tags` -> `{models: [{name, model, digest}]}`.
 * - Errors: a non-2xx status with `{error: "text"}`.
 */

export const CHAT_PATH = "/api/chat";
export const TAGS_PATH = "/api/tags";

interface WireToolCall {
  function: { name: string; arguments: Readonly<Record<string, unknown>> };
}

interface WireMessage {
  role: ChatMessage["role"];
  content: string;
  images?: string[];
  tool_calls?: WireToolCall[];
  tool_name?: string;
}

export interface WireChatRequest {
  model: string;
  messages: WireMessage[];
  tools?: {
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }[];
  format?: unknown;
  stream: false;
  keep_alive: string | number;
  options: { temperature: number };
}

function toWireMessage(message: ChatMessage): WireMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map((call) => ({
            function: { name: call.name, arguments: call.arguments },
          })),
        }),
    ...(message.toolName === undefined ? {} : { tool_name: message.toolName }),
  };
}

export interface WireSettings {
  readonly model: string;
  readonly keepAlive: string | number;
  readonly temperature: number;
}

/** The request body for one chat call. Images go on the first user message, base64 encoded. */
export function buildChatBody(request: ChatRequest, settings: WireSettings): WireChatRequest {
  const messages = request.messages.map(toWireMessage);
  if (request.images !== undefined && request.images.length > 0) {
    const first = messages.find((message) => message.role === "user");
    if (first !== undefined) {
      first.images = request.images.map((image) => Buffer.from(image).toString("base64"));
    }
  }
  return {
    model: settings.model,
    messages,
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
    ...(request.schema === undefined ? {} : { format: request.schema }),
    stream: false,
    keep_alive: settings.keepAlive,
    options: { temperature: settings.temperature },
  };
}

/** The body that loads the model into memory without generating anything (warm-up). */
export function buildLoadBody(settings: WireSettings): {
  model: string;
  messages: [];
  stream: false;
  keep_alive: string | number;
} {
  return { model: settings.model, messages: [], stream: false, keep_alive: settings.keepAlive };
}

/** Tool arguments arrive as an object; some builds send them as a JSON string. */
const argumentsSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.string().transform((text, ctx): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // reported below
    }
    ctx.addIssue({ code: "custom", message: "tool arguments are not a JSON object" });
    return z.NEVER;
  }),
]);

const chatResponseSchema = z.object({
  model: z.string().optional(),
  message: z.object({
    content: z.string().default(""),
    tool_calls: z
      .array(z.object({ function: z.object({ name: z.string(), arguments: argumentsSchema }) }))
      .optional(),
  }),
});

export interface ParsedChat {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly model: string | undefined;
}

export function parseChatResponse(body: unknown): ParsedChat | undefined {
  const parsed = chatResponseSchema.safeParse(body);
  if (!parsed.success) {
    return undefined;
  }
  return {
    content: parsed.data.message.content,
    toolCalls: (parsed.data.message.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    model: parsed.data.model,
  };
}

const tagsSchema = z.object({
  models: z.array(
    z.object({ name: z.string(), model: z.string().optional(), digest: z.string().optional() }),
  ),
});

export interface ListedModel {
  readonly name: string;
  readonly digest: string | undefined;
}

export function parseTags(body: unknown): ListedModel[] | undefined {
  const parsed = tagsSchema.safeParse(body);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.models.map((entry) => ({ name: entry.name, digest: entry.digest }));
}

const errorSchema = z.object({ error: z.string() });

/** The runtime's own error text, when it sent one (e.g. "model not found"). */
export function parseErrorText(body: unknown): string | undefined {
  const parsed = errorSchema.safeParse(body);
  return parsed.success ? parsed.data.error.slice(0, 200) : undefined;
}
