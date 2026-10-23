import { z } from "zod";

import type { ChatMessage, ChatRequest } from "./client.js";

/*
 * UNVERIFIED (builder, on the laptop): everything in this file is a GUESS about the llama.cpp
 * server's HTTP API and its Gemma 4 audio support. The cloud session that wrote it had no network
 * to llama.cpp's docs and no model. Every endpoint, field name and payload shape of the audio
 * wire format lives here and nowhere else; check them against the running `llama-server` and fix
 * only this file. The fake HTTP server in `test/llamacpp-client.test.ts` speaks the same
 * guesses, so a correction here is a correction there.
 *
 * TODO(builder): verify against llama.cpp server docs (tools/server/README.md), each item below:
 *  1. Chat endpoint: `POST /v1/chat/completions` (OpenAI-compatible), not `/completion`.
 *  2. Audio input: an OpenAI-style content part `{type: "input_audio", input_audio: {data:
 *     <base64>, format: "wav"}}` inside the user message's `content` array, next to a
 *     `{type: "text", text}` part. (Alternatives to try if this is refused: a `data:audio/wav;
 *     base64,...` URL in an `audio_url` part, or the multimodal `multimodal_data` field of
 *     `/completion`.)
 *  3. Audio format: 16-bit PCM WAV, 16 kHz, mono (what the phone sends, see `src/web/voice/`).
 *     If Gemma 4's encoder wants another rate or length limit, change the web encoder only.
 *  4. The server must be started with the audio projector for Gemma 4 (`--mmproj <file>`);
 *     whether Gemma 4 E4B audio works in llama.cpp at all is an open question (ADR-0004).
 *  5. Schema-constrained answers: `response_format: {type: "json_schema", json_schema: {name,
 *     strict, schema}}`. Older builds want `{type: "json_object", schema}`; the job runner
 *     validates and retries once either way, so a server that ignores it still works if the
 *     prompt makes the model answer JSON.
 *  6. Answer shape: `{model, choices: [{message: {content: string}}]}` with `stream: false`.
 *  7. Health: `GET /health` -> 200 `{status: "ok"}`, 503 while the model loads.
 *  8. Errors: a non-2xx status with `{error: {message: string}}`.
 *  9. The model name in the request is ignored (the server serves the one model it started
 *     with); `config/models.json` `llamaCpp.model` is only a label for the decision log.
 */

export const COMPLETIONS_PATH = "/v1/chat/completions";
export const HEALTH_PATH = "/health";
/** The audio format the phone sends and the request declares (guess 3). */
export const AUDIO_FORMAT = "wav" as const;

type WireContent =
  | string
  | (
      | { type: "text"; text: string }
      | { type: "input_audio"; input_audio: { data: string; format: typeof AUDIO_FORMAT } }
    )[];

interface WireMessage {
  role: ChatMessage["role"];
  content: WireContent;
}

export interface WireAudioRequest {
  model: string;
  messages: WireMessage[];
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; strict: true; schema: unknown };
  };
  stream: false;
  temperature: number;
}

export interface AudioWireSettings {
  readonly model: string;
  readonly temperature: number;
}

/**
 * The request body for one call. The audio rides on the first user message (guess 2), base64
 * encoded in memory; there is no temp file and the body is never logged.
 */
export function buildAudioChatBody(
  request: ChatRequest,
  settings: AudioWireSettings,
): WireAudioRequest {
  const messages: WireMessage[] = request.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const audio = request.audio ?? [];
  if (audio.length > 0) {
    const first = messages.find((message) => message.role === "user");
    if (first !== undefined) {
      first.content = [
        { type: "text", text: typeof first.content === "string" ? first.content : "" },
        ...audio.map((clip) => ({
          type: "input_audio" as const,
          input_audio: { data: Buffer.from(clip).toString("base64"), format: AUDIO_FORMAT },
        })),
      ];
    }
  }
  return {
    model: settings.model,
    messages,
    ...(request.schema === undefined
      ? {}
      : {
          response_format: {
            type: "json_schema" as const,
            json_schema: { name: "answer", strict: true as const, schema: request.schema },
          },
        }),
    stream: false,
    temperature: settings.temperature,
  };
}

const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().default("") }) }))
    .min(1),
});

export interface ParsedCompletion {
  readonly content: string;
  readonly model: string | undefined;
}

export function parseCompletion(body: unknown): ParsedCompletion | undefined {
  const parsed = completionSchema.safeParse(body);
  const choice = parsed.success ? parsed.data.choices[0] : undefined;
  if (!parsed.success || choice === undefined) {
    return undefined;
  }
  return { content: choice.message.content ?? "", model: parsed.data.model };
}

const errorSchema = z.object({ error: z.object({ message: z.string() }) });

/** The server's own error text, when it sent one (guess 8). */
export function parseErrorText(body: unknown): string | undefined {
  const parsed = errorSchema.safeParse(body);
  return parsed.success ? parsed.data.error.message.slice(0, 200) : undefined;
}
