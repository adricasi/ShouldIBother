import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { LISTENER_AUDIO_JOB } from "../src/server/gemma/listener-audio.js";
import { ModelTimeoutError, ModelUnavailableError } from "../src/server/model/client.js";
import { parseModelsConfig } from "../src/server/model/config.js";
import { FakeModelClient } from "../src/server/model/fake.js";
import { MAX_RESPONSE_BYTES } from "../src/server/model/http.js";
import { LlamaCppAudioClient, NonLoopbackRuntimeError } from "../src/server/model/llamacpp.js";
import { loopbackOrigin } from "../src/server/model/loopback.js";
import { selectModel } from "../src/server/model/select.js";

import { syntheticWav } from "./support/audio.js";

/*
 * The server below speaks llama.cpp's HTTP API as llamacpp-wire.ts GUESSES it (UNVERIFIED until
 * the builder runs the client against a real llama-server with Gemma 4 audio). A correction in
 * the wire file is a correction here.
 */

interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

type Handler = (request: Recorded, response: ServerResponse) => void;

let server: Server | undefined;
afterEach(async () => {
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  }
});

async function fakeLlamaCpp(handler: Handler): Promise<{ url: string; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded: Recorded = {
        method: request.method ?? "",
        url: request.url ?? "",
        body: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>),
      };
      seen.push(recorded);
      handler(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const answer = (content: string) => ({
  model: "gemma4-audio",
  choices: [{ message: { role: "assistant", content } }],
});

const audioRequest = (audio: Uint8Array) => ({
  job: LISTENER_AUDIO_JOB,
  messages: [
    { role: "system" as const, content: "system text" },
    { role: "user" as const, content: "user text" },
  ],
  audio: [audio],
  timeoutMs: 5_000,
});

describe("LlamaCppAudioClient (request format against a fake server)", () => {
  it("posts the audio as a base64 input_audio part of the user message, with the schema, to /v1/chat/completions", async () => {
    const { url, seen } = await fakeLlamaCpp((_req, res) =>
      json(res, 200, answer('{"status":"ok","transcript":"hola"}')),
    );
    const wav = syntheticWav({ seconds: 0.1 });
    const schema = { type: "object", properties: { transcript: { type: "string" } } };
    const client = new LlamaCppAudioClient({ baseUrl: url, model: "gemma4-audio" });
    const response = await client.chat({ ...audioRequest(wav), schema });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/chat/completions" });
    expect(seen[0]?.body).toEqual({
      model: "gemma4-audio",
      messages: [
        { role: "system", content: "system text" },
        {
          role: "user",
          content: [
            { type: "text", text: "user text" },
            { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", strict: true, schema },
      },
      stream: false,
      temperature: 0,
    });
    expect(response).toEqual({
      content: '{"status":"ok","transcript":"hola"}',
      toolCalls: [],
      model: "gemma4-audio",
    });
  });

  it("refuses tools: it is the audio client only", async () => {
    const { url } = await fakeLlamaCpp((_req, res) => json(res, 200, answer("{}")));
    const client = new LlamaCppAudioClient({ baseUrl: url, model: "m" });
    await expect(
      client.chat({
        ...audioRequest(syntheticWav()),
        tools: [{ name: "t", description: "d", parameters: {} }],
      }),
    ).rejects.toThrow(/no tools/);
  });

  it("reports online from /health and offline when the server is down or still loading", async () => {
    const { url } = await fakeLlamaCpp((req, res) =>
      req.url === "/health"
        ? json(res, 503, { error: { message: "Loading model" } })
        : json(res, 404, {}),
    );
    const loading = await new LlamaCppAudioClient({ baseUrl: url, model: "m" }).health();
    expect(loading.state).toBe("offline");
    expect(loading.detail).toContain("Loading model");
    const down = await new LlamaCppAudioClient({
      baseUrl: "http://127.0.0.1:1",
      model: "m",
    }).health();
    expect(down.state).toBe("offline");
  });

  it("reports online when /health answers", async () => {
    const { url, seen } = await fakeLlamaCpp((_req, res) => json(res, 200, { status: "ok" }));
    const health = await new LlamaCppAudioClient({ baseUrl: url, model: "gemma4-audio" }).health();
    expect(health).toEqual({ state: "online", detail: "gemma4-audio" });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/health" });
  });
});

describe("LlamaCppAudioClient failures", () => {
  it("maps a server that is not running to ModelUnavailableError", async () => {
    const client = new LlamaCppAudioClient({ baseUrl: "http://127.0.0.1:1", model: "m" });
    await expect(client.chat(audioRequest(syntheticWav()))).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
  });

  it("maps an HTTP error to ModelUnavailableError with the server's message", async () => {
    const { url } = await fakeLlamaCpp((_req, res) =>
      json(res, 500, { error: { message: "audio is not supported by this model" } }),
    );
    const client = new LlamaCppAudioClient({ baseUrl: url, model: "m" });
    await expect(client.chat(audioRequest(syntheticWav()))).rejects.toThrow(
      /500.*audio is not supported/,
    );
  });

  it("maps a call that outlasts its timeout to ModelTimeoutError", async () => {
    const { url } = await fakeLlamaCpp(() => undefined);
    const client = new LlamaCppAudioClient({ baseUrl: url, model: "m" });
    await expect(
      client.chat({ ...audioRequest(syntheticWav()), timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(ModelTimeoutError);
  });

  it("refuses an answer it cannot read and one that is too large", async () => {
    const { url } = await fakeLlamaCpp((_req, res) => json(res, 200, { nope: true }));
    const client = new LlamaCppAudioClient({ baseUrl: url, model: "m" });
    await expect(client.chat(audioRequest(syntheticWav()))).rejects.toThrow(/cannot read/);
    await new Promise((resolve) => server?.close(resolve));
    const big = await fakeLlamaCpp((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(`{"choices":[{"message":{"content":"${"x".repeat(MAX_RESPONSE_BYTES)}`);
      res.end('"}}]}');
    });
    await expect(
      new LlamaCppAudioClient({ baseUrl: big.url, model: "m" }).chat(audioRequest(syntheticWav())),
    ).rejects.toThrow(/too large/);
  });
});

describe("AC-027.2: the audio client only targets loopback", () => {
  it.each([
    "http://192.168.1.20:8080",
    "http://10.0.0.5:8080",
    "http://example.com:8080",
    "http://localhost:8080",
    "https://127.0.0.1:8080",
    "http://127.0.0.1.evil.example:8080",
    "not a url",
  ])("refuses %s at construction, before any request", (baseUrl) => {
    let requested = false;
    const spy = (() => {
      requested = true;
      return Promise.reject(new Error("must not be called"));
    }) as typeof fetch;
    expect(() => new LlamaCppAudioClient({ baseUrl, model: "m", fetch: spy })).toThrow(
      NonLoopbackRuntimeError,
    );
    expect(requested).toBe(false);
  });

  it("accepts 127.0.0.1 and [::1] only", () => {
    expect(loopbackOrigin("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    expect(loopbackOrigin("http://[::1]:8080")).toBe("http://[::1]:8080");
    expect(loopbackOrigin("http://0.0.0.0:8080")).toBeUndefined();
  });

  it("uses no host but the configured loopback one, and refuses redirects", async () => {
    const hosts: string[] = [];
    const redirects: (string | undefined)[] = [];
    const recordingFetch = ((input: string | URL | Request, init?: RequestInit) => {
      hosts.push(new URL(input instanceof Request ? input.url : input).hostname);
      redirects.push(init?.redirect);
      return Promise.resolve(Response.json(answer('{"status":"ok","transcript":"x"}')));
    }) as typeof fetch;
    const client = new LlamaCppAudioClient({
      baseUrl: "http://127.0.0.1:8080",
      model: "m",
      fetch: recordingFetch,
    });
    await client.chat(audioRequest(syntheticWav()));
    await client.health();
    expect(hosts).toEqual(["127.0.0.1", "127.0.0.1"]);
    expect(redirects).toEqual(["error", "error"]);
  });

  it("a redirect to another host is not followed", async () => {
    const { url } = await fakeLlamaCpp((_req, res) => {
      res.writeHead(302, { location: "http://example.com/steal" });
      res.end();
    });
    const client = new LlamaCppAudioClient({ baseUrl: url, model: "m" });
    await expect(client.chat(audioRequest(syntheticWav()))).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
  });

  it("a non-loopback llamaCpp.baseUrl in config/models.json is an error", () => {
    expect(() => parseModelsConfig({ llamaCpp: { baseUrl: "http://192.168.1.20:8080" } })).toThrow(
      /llama\.cpp must be an http URL on 127\.0\.0\.1/,
    );
    expect(parseModelsConfig({}).llamaCpp).toEqual({
      baseUrl: "http://127.0.0.1:8080",
      model: "gemma4-audio",
    });
  });
});

describe("selectModel with the voice flag", () => {
  const config = parseModelsConfig({ models: { e4b: { tag: "gemma4:e4b" } } });
  const ollamaDown = (() => Promise.reject(new Error("down"))) as typeof fetch;

  it("gives the voice job the llama.cpp client and leaves every other job on the primary model", async () => {
    const selection = await selectModel(config, {
      useFake: false,
      fake: () => new FakeModelClient(),
      voice: true,
      fetch: ollamaDown,
    });
    expect(Object.keys(selection.jobModels)).toEqual([LISTENER_AUDIO_JOB]);
    expect(selection.jobModels[LISTENER_AUDIO_JOB]).toBeInstanceOf(LlamaCppAudioClient);
    expect(selection.notice).toContain("Voice: llama.cpp audio at http://127.0.0.1:8080");
  });

  it("sets up no voice runtime while the flag is off, and none on the fake model", async () => {
    const off = await selectModel(config, {
      useFake: false,
      fake: () => new FakeModelClient(),
      fetch: ollamaDown,
    });
    expect(off.jobModels).toEqual({});
    expect(off.notice).not.toContain("Voice");
    const fake = await selectModel(config, {
      useFake: true,
      fake: () => new FakeModelClient(),
      voice: true,
    });
    expect(fake.jobModels).toEqual({});
  });
});
