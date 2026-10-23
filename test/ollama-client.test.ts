import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ModelTimeoutError, ModelUnavailableError } from "../src/server/model/client.js";
import { parseModelsConfig, primaryModelTag } from "../src/server/model/config.js";
import { MAX_RESPONSE_BYTES, OllamaClient } from "../src/server/model/ollama.js";
import { selectModel } from "../src/server/model/select.js";
import { FakeModelClient } from "../src/server/model/fake.js";

/*
 * The server below speaks Ollama's documented HTTP API as ollama-wire.ts assumes it (UNVERIFIED
 * until T-010 runs the client against a real Ollama). A correction in the wire file is a
 * correction here.
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

async function fakeOllama(handler: Handler): Promise<{ url: string; seen: Recorded[] }> {
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

const TAG = "gemma4:e4b";
const TAGS = { models: [{ name: TAG, model: TAG, digest: "sha256:synthetic0042" }] };

function ollama(url: string, extra: Partial<ConstructorParameters<typeof OllamaClient>[0]> = {}) {
  return new OllamaClient({ baseUrl: url, model: TAG, keepAlive: "24h", temperature: 0, ...extra });
}

const request = {
  job: "bookmaker",
  messages: [
    { role: "system" as const, content: "system text" },
    { role: "user" as const, content: "user text" },
  ],
  timeoutMs: 5_000,
};

describe("OllamaClient (request format against a fake server)", () => {
  it("posts messages, model tag, JSON schema as format, keep_alive and no streaming to /api/chat", async () => {
    const { url, seen } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? json(res, 200, TAGS)
        : json(res, 200, {
            model: TAG,
            message: { role: "assistant", content: '{"a":1}' },
            done: true,
          }),
    );
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const response = await ollama(url).chat({ ...request, schema });
    const chat = seen.find((entry) => entry.url === "/api/chat");
    expect(chat).toMatchObject({ method: "POST" });
    expect(chat?.body).toEqual({
      model: TAG,
      messages: [
        { role: "system", content: "system text" },
        { role: "user", content: "user text" },
      ],
      format: schema,
      stream: false,
      keep_alive: "24h",
      options: { temperature: 0 },
    });
    expect(response).toEqual({
      content: '{"a":1}',
      toolCalls: [],
      model: TAG,
      // Not known yet at the first call, so the chat looked it up first (AC-019.4).
      modelDigest: "sha256:synthetic0042",
    });
  });

  it("sends tools, the tool-call history and tool results; reads tool calls from the answer", async () => {
    const { url, seen } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? json(res, 200, TAGS)
        : json(res, 200, {
            model: TAG,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "get_forecast", arguments: { hours_ahead: 24 } } }],
            },
            done: true,
          }),
    );
    const response = await ollama(url).chat({
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: "",
          toolCalls: [{ name: "get_forecast", arguments: { hours_ahead: 6 } }],
        },
        { role: "tool", content: "rows", toolName: "get_forecast" },
      ],
      tools: [
        {
          name: "get_forecast",
          description: "forecast",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(response.toolCalls).toEqual([{ name: "get_forecast", arguments: { hours_ahead: 24 } }]);
    const body = seen.find((entry) => entry.url === "/api/chat")?.body as {
      messages: Record<string, unknown>[];
      tools: unknown[];
    };
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_forecast",
          description: "forecast",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "get_forecast", arguments: { hours_ahead: 6 } } }],
    });
    expect(body.messages[3]).toEqual({ role: "tool", content: "rows", tool_name: "get_forecast" });
  });

  it("reads tool arguments sent as a JSON string", async () => {
    const { url } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? json(res, 200, TAGS)
        : json(res, 200, {
            message: {
              content: "",
              tool_calls: [{ function: { name: "get_forecast", arguments: '{"hours_ahead":3}' } }],
            },
          }),
    );
    const response = await ollama(url).chat(request);
    expect(response.toolCalls).toEqual([{ name: "get_forecast", arguments: { hours_ahead: 3 } }]);
    expect(response.model).toBe(TAG);
  });

  it("sends images base64 encoded on the first user message", async () => {
    const { url, seen } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? json(res, 200, TAGS)
        : json(res, 200, { message: { content: "{}" } }),
    );
    await ollama(url).chat({ ...request, images: [new Uint8Array([1, 2, 3])] });
    const body = seen.find((entry) => entry.url === "/api/chat")?.body as {
      messages: { images?: string[] }[];
    };
    expect(body.messages[0]?.images).toBeUndefined();
    expect(body.messages[1]?.images).toEqual([Buffer.from([1, 2, 3]).toString("base64")]);
  });

  it("a chat whose digest is unknown looks it up once with one list call, then remembers it", async () => {
    const { url, seen } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? json(res, 200, TAGS)
        : json(res, 200, { message: { content: "{}" } }),
    );
    const client = ollama(url);
    expect((await client.chat(request)).modelDigest).toBe("sha256:synthetic0042");
    expect(seen.map((entry) => entry.url)).toEqual(["/api/tags", "/api/chat"]);
    expect((await client.chat(request)).modelDigest).toBe("sha256:synthetic0042");
    expect(seen.filter((entry) => entry.url === "/api/tags")).toHaveLength(1);
  });

  it("a chat makes no extra request once the health check has the digest", async () => {
    const { url, seen } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? json(res, 200, TAGS)
        : json(res, 200, { message: { content: "{}" } }),
    );
    const client = ollama(url);
    await client.health();
    expect((await client.chat(request)).modelDigest).toBe("sha256:synthetic0042");
    expect(seen.filter((entry) => entry.url === "/api/tags")).toHaveLength(1);
  });

  it("an empty digest counts as missing and is looked up again, and a model listed without one is asked once", async () => {
    let digest = "";
    const { url, seen } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? json(res, 200, { models: [{ name: TAG, digest }] })
        : json(res, 200, { message: { content: "{}" } }),
    );
    const client = ollama(url);
    expect((await client.chat(request)).modelDigest).toBeUndefined();
    await client.chat(request);
    expect(seen.filter((entry) => entry.url === "/api/tags")).toHaveLength(1);
    // Ollama later reports a digest (a health check refreshes it).
    digest = "sha256:later";
    await client.health();
    expect((await client.chat(request)).modelDigest).toBe("sha256:later");
  });

  it("a failed lookup does not stop the chat, and is tried again at the next call", async () => {
    let tagsUp = false;
    const { url, seen } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? tagsUp
          ? json(res, 200, TAGS)
          : json(res, 500, { error: "busy" })
        : json(res, 200, { message: { content: "{}" } }),
    );
    const client = ollama(url);
    expect((await client.chat(request)).modelDigest).toBeUndefined();
    tagsUp = true;
    expect((await client.chat(request)).modelDigest).toBe("sha256:synthetic0042");
    expect(seen.filter((entry) => entry.url === "/api/tags")).toHaveLength(2);
  });

  it("the warm-up also takes the digest", async () => {
    const { url } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? json(res, 200, TAGS)
        : json(res, 200, { model: TAG, message: { content: "{}" }, done: true }),
    );
    const client = ollama(url);
    await client.warmUp();
    expect((await client.chat(request)).modelDigest).toBe("sha256:synthetic0042");
  });

  it("still answers when no digest is known", async () => {
    const { url } = await fakeOllama((req, res) =>
      req.url === "/api/tags"
        ? json(res, 500, { error: "x" })
        : json(res, 200, { message: { content: "{}" } }),
    );
    const answer = await ollama(url).chat(request);
    expect(answer.content).toBe("{}");
    expect(answer.modelDigest).toBeUndefined();
  });
});

describe("OllamaClient (failures become the errors the jobs understand)", () => {
  it("AC-013.3: a runtime that is not running is ModelUnavailableError", async () => {
    // Port 9 (discard) on loopback is closed.
    await expect(ollama("http://127.0.0.1:9").chat(request)).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
  });

  it("NFR-004: a call that outlasts timeoutMs is ModelTimeoutError", async () => {
    const { url } = await fakeOllama(() => undefined);
    await expect(ollama(url).chat({ ...request, timeoutMs: 50 })).rejects.toBeInstanceOf(
      ModelTimeoutError,
    );
  });

  it("an HTTP error with Ollama's own message is ModelUnavailableError carrying it", async () => {
    const { url } = await fakeOllama((_req, res) =>
      json(res, 404, { error: "model 'gemma4:e4b' not found" }),
    );
    await expect(ollama(url).chat(request)).rejects.toThrow(/404.*not found/);
  });

  it("refuses a redirect instead of following it off 127.0.0.1", async () => {
    const { url, seen } = await fakeOllama((_req, res) => {
      res.writeHead(307, { location: "http://127.0.0.1:9/api/chat" });
      res.end();
    });
    await expect(ollama(url).chat(request)).rejects.toBeInstanceOf(ModelUnavailableError);
    // The digest lookup (a list, which also gets the redirect) and the chat: nothing was followed.
    expect(seen.filter((entry) => entry.url === "/api/chat")).toHaveLength(1);
    expect(seen.every((entry) => entry.url !== "/api/chat" || entry.method === "POST")).toBe(true);
  });

  it("refuses an answer over 1 MB, declared or streamed", async () => {
    const { url } = await fakeOllama((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(`{"message":{"content":"${"x".repeat(MAX_RESPONSE_BYTES)}`);
      res.end(`"}}`);
    });
    await expect(ollama(url).chat(request)).rejects.toThrow(/too large/);
  });

  it("an answer that is not the expected shape is ModelUnavailableError", async () => {
    const { url } = await fakeOllama((_req, res) => json(res, 200, { unexpected: true }));
    await expect(ollama(url).chat(request)).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});

describe("OllamaClient health and warm-up", () => {
  it("AC-013.5: online when the model is listed, offline when Ollama is down or the tag is missing", async () => {
    const { url } = await fakeOllama((_req, res) => json(res, 200, TAGS));
    expect(await ollama(url).health()).toMatchObject({ state: "online" });
    expect(await ollama("http://127.0.0.1:9").health()).toMatchObject({ state: "offline" });
    expect(await ollama(url, { model: "gemma4:e2b" }).health()).toMatchObject({
      state: "offline",
      detail: expect.stringContaining("not pulled") as unknown,
    });
  });

  it("matches the model name with :latest normalised", async () => {
    const { url } = await fakeOllama((_req, res) =>
      json(res, 200, { models: [{ name: "gemma4:latest", digest: "sha256:l" }] }),
    );
    expect(await ollama(url, { model: "gemma4" }).health()).toMatchObject({ state: "online" });
    expect(await ollama(url, { model: "gemma4:latest" }).health()).toMatchObject({
      state: "online",
    });
  });

  it("warm-up loads the model with an empty chat and keep_alive; status is 'waking' meanwhile", async () => {
    let finish: () => void = () => undefined;
    const { url, seen } = await fakeOllama((req, res) => {
      if (req.url === "/api/tags") {
        json(res, 200, TAGS);
      } else {
        finish = () => json(res, 200, { model: TAG, done: true });
      }
    });
    const client = ollama(url);
    const warming = client.warmUp();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await client.health()).toMatchObject({ state: "waking" });
    finish();
    expect(await warming).toMatchObject({ state: "online" });
    expect(await client.health()).toMatchObject({ state: "online" });
    expect(seen.find((entry) => entry.url === "/api/chat")?.body).toEqual({
      model: TAG,
      messages: [],
      stream: false,
      keep_alive: "24h",
    });
  });

  it("a failed warm-up reports offline and does not throw", async () => {
    expect(await ollama("http://127.0.0.1:9").warmUp()).toMatchObject({ state: "offline" });
  });
});

describe("config/models.json and the startup choice", () => {
  const config = (models: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseModelsConfig({ models, ...extra });

  it("has defaults: no model, loopback Ollama, keep_alive 24 h, native tools", () => {
    expect(parseModelsConfig({})).toMatchObject({
      primary: "e4b",
      models: {},
      ollama: { baseUrl: "http://127.0.0.1:11434", keepAlive: "24h", temperature: 0 },
      gemma: { toolUse: "native", answerMode: "single_call" },
    });
    expect(primaryModelTag(parseModelsConfig({}))).toBeUndefined();
  });

  it("names the model by tag, with quantization and digest", () => {
    const parsed = config({ e4b: { tag: TAG, quantization: "Q4_K_M", digest: "sha256:x" } });
    expect(primaryModelTag(parsed)).toBe(TAG);
  });

  it("NFR-001: refuses an Ollama address that is not loopback", () => {
    for (const baseUrl of [
      "http://192.168.1.5:11434",
      "http://example.com",
      "https://127.0.0.1",
      "http://localhost:11434",
    ]) {
      expect(() => config({}, { ollama: { baseUrl } })).toThrow(/127\.0\.0\.1/);
    }
    expect(() => config({}, { ollama: { baseUrl: "http://[::1]:11434" } })).not.toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => config({}, { surprise: true })).toThrow();
  });

  it("refuses to start without a model tag, saying how to set it", async () => {
    await expect(
      selectModel(parseModelsConfig({}), { useFake: false, fake: () => new FakeModelClient() }),
    ).rejects.toThrow(/config\/models\.json.*models\.e4b\.tag.*SIB_FAKE_MODEL=1/);
  });

  it("never builds the fake model unless SIB_FAKE_MODEL=1 asked for it", async () => {
    let built = 0;
    const fake = (): FakeModelClient => {
      built += 1;
      return new FakeModelClient();
    };
    // No tag: error. Tag but Ollama down: Ollama client, offline. Neither builds the fake.
    await expect(selectModel(parseModelsConfig({}), { useFake: false, fake })).rejects.toThrow();
    const down = await selectModel(
      config({ e4b: { tag: TAG } }, { ollama: { baseUrl: "http://127.0.0.1:9" } }),
      { useFake: false, fake },
    );
    expect(built).toBe(0);
    expect(down.mode).toBe("ollama");
    expect(down.model).toBeInstanceOf(OllamaClient);
    await expect(down.model.health()).resolves.toMatchObject({ state: "offline" });
    expect(down.notice).not.toContain("FAKE");
    expect(down.notice).toContain("not usable yet");
  });

  it("SIB_FAKE_MODEL=1 uses the fake model with a loud banner, even with no tag", async () => {
    const fake = new FakeModelClient();
    const selection = await selectModel(parseModelsConfig({}), { useFake: true, fake: () => fake });
    expect(selection.model).toBe(fake);
    expect(selection.mode).toBe("fake");
    expect(selection.notice).toContain("!!! FAKE MODEL");
    expect(selection.notice).toContain("NOT from Gemma");
    expect(await selection.model.health()).toMatchObject({ detail: "fake model" });
  });

  it("uses OllamaClient when the model is named and Ollama answers with it", async () => {
    const { url } = await fakeOllama((_req, res) => json(res, 200, TAGS));
    const selection = await selectModel(
      config({ e4b: { tag: TAG } }, { ollama: { baseUrl: url } }),
      { useFake: false, fake: () => new FakeModelClient() },
    );
    expect(selection.mode).toBe("ollama");
    expect(selection.model).toBeInstanceOf(OllamaClient);
    expect(selection.warmUp).toBeDefined();
  });
});
