import { z } from "zod";

import type { ChatMessage, ChatRequest, ToolCall } from "./client.js";
import { argumentsSchema } from "./ollama-wire.js";

/*
 * UNVERIFIED (T-040): everything in this file is written from the documented OpenAI-compatible
 * chat API (`POST /v1/chat/completions`, `GET /v1/models`) that DigitalOcean's Serverless
 * Inference says it offers, without a key and without network access to it: the cloud session
 * that wrote it cannot reach DigitalOcean. Every path and field name of the wire format lives here
 * and nowhere else; the builder checks them against the real service (`GET /v1/models` names the
 * model ID for `SIB_DO_MODEL`) and fixes only this file. The fake HTTP server in
 * `test/digitalocean-client.test.ts` speaks the same assumptions, so a correction here is a
 * correction there.
 *
 * Assumed:
 * - Chat: `POST /v1/chat/completions` with `{model, messages, tools?, response_format?, stream:
 *   false, temperature}`. A message is `{role, content, tool_calls?: [{id, type: "function",
 *   function: {name, arguments: <JSON string>}}], tool_call_id?}`; images are `image_url` parts of
 *   the first user message (data URIs). The answer is `{model, choices: [{message: {content,
 *   tool_calls?}}]}` with `content` null when the model only calls a tool.
 * - JSON answers: `response_format` of type `json_schema` (see RESPONSE_FORMAT); the answer is
 *   validated with zod by the job runner either way.
 * - Models: `GET /v1/models` -> `{data: [{id}]}`.
 * - Errors: a non-2xx status with `{error: {message}}`, `{error: "text"}` or `{message}`.
 * - Tool history: with `SIB_TOOL_USE=injected` (the default) the app does the tool call itself
 *   and the history is sent as plain text turns, so the service needs neither a `tools` list nor
 *   `tool` role messages for it. Only `native` mode sends `tool_calls` and `tool` messages.
 */

export const CHAT_PATH = "/v1/chat/completions";
export const MODELS_PATH = "/v1/models";

/**
 * How a job's JSON schema is sent. `json_schema` constrains the answer to the schema;
 * `json_object` only asks for some JSON (the prompt already says what shape). If the service
 * rejects `json_schema` for Gemma, switching this one constant is the fix.
 */
export const RESPONSE_FORMAT: "json_schema" | "json_object" = "json_schema";

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type WirePart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface WireMessage {
  role: ChatMessage["role"];
  content: string | WirePart[] | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

export interface WireChatRequest {
  model: string;
  messages: WireMessage[];
  tools?: {
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }[];
  response_format?:
    | { type: "json_schema"; json_schema: { name: string; schema: unknown } }
    | { type: "json_object" };
  stream: false;
  temperature: number;
}

export interface WireSettings {
  readonly model: string;
  readonly temperature: number;
  /** `injected`: tool turns of the history go as text. `native`: as `tool_calls` and `tool` messages. */
  readonly toolUse: "injected" | "native";
}

/** The tool turns as plain text, for a service that is not asked to do tool calling. */
function flattenToolTurns(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message): ChatMessage => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: `Result of ${message.toolName ?? "the tool"}:\n${message.content}`,
      };
    }
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      const calls = message.toolCalls
        .map((call) => `I called ${call.name} with ${JSON.stringify(call.arguments)}.`)
        .join("\n");
      return {
        role: "assistant",
        content: message.content === "" ? calls : `${message.content}\n${calls}`,
      };
    }
    return message;
  });
}

/** Chat templates of open models want alternating turns: two turns of one role become one. */
function mergeSameRole(messages: readonly ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      previous.role === message.role &&
      message.role !== "tool" &&
      previous.toolCalls === undefined &&
      message.toolCalls === undefined
    ) {
      merged[merged.length - 1] = {
        ...previous,
        content: `${previous.content}\n\n${message.content}`,
      };
    } else {
      merged.push(message);
    }
  }
  return merged;
}

/** Native mode: every `tool` message answers one earlier call, matched by tool name in order. */
function toNativeMessages(messages: readonly ChatMessage[]): WireMessage[] {
  const pending: { id: string; name: string }[] = [];
  return messages.map((message, index): WireMessage => {
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      const calls = message.toolCalls.map((call, position) => ({
        id: `call_${index}_${position}`,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
      pending.push(...calls.map((call) => ({ id: call.id, name: call.function.name })));
      return {
        role: "assistant",
        content: message.content === "" ? null : message.content,
        tool_calls: calls,
      };
    }
    if (message.role === "tool") {
      const at = pending.findIndex((entry) => entry.name === message.toolName);
      const [match] = pending.splice(at === -1 ? 0 : at, 1);
      return {
        role: "tool",
        content: message.content,
        tool_call_id: match?.id ?? `call_${index}_0`,
      };
    }
    return { role: message.role, content: message.content };
  });
}

/** PNG or JPEG by the file's first bytes: the photo store keeps JPEG, the hosted check sends a PNG. */
function mimeOf(image: Uint8Array): "image/png" | "image/jpeg" {
  return image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47
    ? "image/png"
    : "image/jpeg";
}

/** The request body for one chat call. Images go on the first user message, as data URIs. */
export function buildChatBody(request: ChatRequest, settings: WireSettings): WireChatRequest {
  const turns =
    settings.toolUse === "injected"
      ? mergeSameRole(flattenToolTurns(request.messages))
      : request.messages;
  const messages = toNativeMessages(turns);
  if (request.images !== undefined && request.images.length > 0) {
    const first = messages.find((message) => message.role === "user");
    if (first !== undefined && typeof first.content === "string") {
      first.content = [
        { type: "text", text: first.content },
        ...request.images.map((image): WirePart => ({
          type: "image_url",
          image_url: {
            url: `data:${mimeOf(image)};base64,${Buffer.from(image).toString("base64")}`,
          },
        })),
      ];
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
    ...(request.schema === undefined
      ? {}
      : {
          response_format:
            RESPONSE_FORMAT === "json_schema"
              ? {
                  type: "json_schema" as const,
                  json_schema: { name: `${request.job}_answer`, schema: request.schema },
                }
              : { type: "json_object" as const },
        }),
    stream: false,
    temperature: settings.temperature,
  };
}

const chatResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({ function: z.object({ name: z.string(), arguments: argumentsSchema }) }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
});

export interface ParsedChat {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly model: string | undefined;
}

export function parseChatResponse(body: unknown): ParsedChat | undefined {
  const parsed = chatResponseSchema.safeParse(body);
  const message = parsed.success ? parsed.data.choices[0]?.message : undefined;
  if (!parsed.success || message === undefined) {
    return undefined;
  }
  return {
    content: message.content ?? "",
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    model: parsed.data.model,
  };
}

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/** The model IDs the service lists, or undefined when the answer is not a model list. */
export function parseModelIds(body: unknown): string[] | undefined {
  const parsed = modelsSchema.safeParse(body);
  return parsed.success ? parsed.data.data.map((entry) => entry.id) : undefined;
}

const errorCodeSchema = z.union([
  z.object({ error: z.object({ code: z.string() }) }).transform((body) => body.error.code),
  z.object({ error: z.object({ type: z.string() }) }).transform((body) => body.error.type),
]);

/**
 * The machine-readable code of an error answer (e.g. `model_not_found`), when it sent a short
 * one. The free text of an error is dropped on purpose: a service may echo the request into it,
 * and the request holds the prompt and the key (AC-032.2).
 */
export function parseErrorCode(body: unknown): string | undefined {
  const parsed = errorCodeSchema.safeParse(body);
  return parsed.success && /^[A-Za-z0-9_.-]{1,60}$/.test(parsed.data) ? parsed.data : undefined;
}
