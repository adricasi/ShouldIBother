import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { DIGITALOCEAN_INFERENCE_URL } from "../../src/server/model/digitalocean.js";

/*
 * A fake of DigitalOcean's OpenAI-compatible inference API on 127.0.0.1 (no network in tests). It
 * speaks the assumptions of digitalocean-wire.ts, which are UNVERIFIED until the builder runs
 * `sib hosted-check`; a correction in the wire file is a correction here.
 */

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly text: string;
  readonly body: Record<string, unknown> | undefined;
}

export type Handler = (request: Recorded, response: ServerResponse) => void;

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export const MODEL_ID = "gemma-4-31B-it";
export const KEY = "dop_v1_synthetic_key_0123456789abcdef";

/** The answer of a chat call whose content is `content`, optionally with tool calls. */
export function chatAnswer(
  content: string | null,
  toolCalls: { name: string; arguments: unknown }[] = [],
): unknown {
  return {
    id: "chatcmpl-synthetic",
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length === 0
            ? {}
            : {
                tool_calls: toolCalls.map((call, index) => ({
                  id: `call_${index}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }),
        },
      },
    ],
  };
}

export interface FakeDigitalOcean {
  readonly url: string;
  readonly seen: Recorded[];
  /** `fetch` for the client under test: the production URL goes to this server. */
  readonly fetch: typeof fetch;
  /** The URLs the client asked `fetch` for, before the rewrite: only the allowlisted host. */
  readonly requestedUrls: string[];
  close(): Promise<void>;
}

export async function startFakeDigitalOcean(handler: Handler): Promise<FakeDigitalOcean> {
  const seen: Recorded[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded: Recorded = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        text,
        body: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>),
      };
      seen.push(recorded);
      handler(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const requestedUrls: string[] = [];
  const rewrite: typeof fetch = (input, init) => {
    const requested =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requestedUrls.push(requested);
    return fetch(requested.replace(DIGITALOCEAN_INFERENCE_URL, url), init);
  };
  return {
    url,
    seen,
    fetch: rewrite,
    requestedUrls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A well-behaved service: lists the model, answers chat with `answer`. */
export function wellBehaved(answer: (request: Recorded) => unknown): Handler {
  return (request, response) => {
    if (request.url === "/v1/models") {
      json(response, 200, { object: "list", data: [{ id: MODEL_ID }, { id: "llama-3-8b" }] });
    } else if (request.url === "/v1/chat/completions") {
      json(response, 200, answer(request));
    } else {
      json(response, 404, { error: { message: "not found" } });
    }
  };
}
