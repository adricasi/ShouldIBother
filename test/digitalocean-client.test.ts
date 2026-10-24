import { afterEach, describe, expect, it } from "vitest";

import { ModelTimeoutError, ModelUnavailableError } from "../src/server/model/client.js";
import {
  DIGITALOCEAN_ALLOWED_HOSTS,
  DIGITALOCEAN_INFERENCE_URL,
  DigitalOceanClient,
  DisallowedInferenceHostError,
  assertInferenceUrl,
} from "../src/server/model/digitalocean.js";
import { Secret } from "../src/server/mode.js";

import {
  KEY,
  MODEL_ID,
  chatAnswer,
  json,
  startFakeDigitalOcean,
  wellBehaved,
  type FakeDigitalOcean,
} from "./support/fake-digitalocean.js";

let fake: FakeDigitalOcean | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

function client(
  extra: Partial<ConstructorParameters<typeof DigitalOceanClient>[0]> = {},
  used: FakeDigitalOcean | undefined = fake,
) {
  return new DigitalOceanClient({
    model: MODEL_ID,
    apiKey: new Secret(KEY),
    vision: false,
    toolUse: "injected",
    ...(used === undefined ? {} : { fetch: used.fetch }),
    ...extra,
  });
}

const request = {
  job: "bookmaker",
  messages: [
    { role: "system" as const, content: "system text" },
    { role: "user" as const, content: "user text" },
  ],
  timeoutMs: 5_000,
};

const FORECAST_TOOL = {
  name: "get_forecast",
  description: "Hourly forecast",
  parameters: { type: "object", properties: { hours_ahead: { type: "integer" } } },
};

describe("AC-032.2: the request format against a fake inference server", () => {
  it("posts to /v1/chat/completions with the bearer key, the model ID, the JSON schema and no streaming", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer('{"a":1}')));
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const response = await client().chat({ ...request, schema });
    const chat = fake.seen[0];
    expect(chat).toMatchObject({ method: "POST", url: "/v1/chat/completions" });
    expect(chat?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(chat?.body).toEqual({
      model: MODEL_ID,
      messages: [
        { role: "system", content: "system text" },
        { role: "user", content: "user text" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "bookmaker_answer", schema },
      },
      stream: false,
      temperature: 0,
    });
    expect(response).toEqual({ content: '{"a":1}', toolCalls: [], model: MODEL_ID });
    expect(fake.requestedUrls).toEqual([`${DIGITALOCEAN_INFERENCE_URL}/v1/chat/completions`]);
  });

  it("sends tool definitions and reads a tool call (arguments arrive as a JSON string)", async () => {
    fake = await startFakeDigitalOcean(
      wellBehaved(() =>
        chatAnswer(null, [{ name: "get_forecast", arguments: { hours_ahead: 24 } }]),
      ),
    );
    const response = await client({ toolUse: "native" }).chat({
      ...request,
      tools: [FORECAST_TOOL],
    });
    expect(fake.seen[0]?.body?.["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "get_forecast",
          description: "Hourly forecast",
          parameters: FORECAST_TOOL.parameters,
        },
      },
    ]);
    expect(response.toolCalls).toEqual([{ name: "get_forecast", arguments: { hours_ahead: 24 } }]);
    expect(response.content).toBe("");
  });

  it("native tool use sends the history as tool_calls and a tool message with a matching id", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer("{}")));
    await client({ toolUse: "native" }).chat({
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
    });
    const messages = fake.seen[0]?.body?.["messages"] as Record<string, unknown>[];
    const assistant = messages[2] as { tool_calls: { id: string; function: unknown }[] };
    expect(assistant.tool_calls[0]?.function).toEqual({
      name: "get_forecast",
      arguments: '{"hours_ahead":6}',
    });
    expect(messages[3]).toEqual({
      role: "tool",
      content: "rows",
      tool_call_id: assistant.tool_calls[0]?.id,
    });
  });

  it("injected tool use (the default) sends the tool turns as plain text, with alternating roles", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer("{}")));
    await client({ toolUse: "injected" }).chat({
      ...request,
      messages: [
        ...request.messages,
        { role: "user", content: "retry text" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ name: "get_forecast", arguments: { hours_ahead: 6 } }],
        },
        { role: "tool", content: "rows", toolName: "get_forecast" },
      ],
    });
    const body = fake.seen[0]?.body as { messages: { role: string; content: string }[] };
    expect(body.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages[1]?.content).toBe("user text\n\nretry text");
    expect(body.messages[3]?.content).toBe("Result of get_forecast:\nrows");
    expect(JSON.stringify(body)).not.toContain("tool_calls");
    expect(JSON.stringify(body)).not.toContain('"tool"');
  });

  it("sends an image as a data URI only when vision is on; off, nothing is sent", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer("{}")));
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await expect(client({ vision: false }).chat({ ...request, images: [image] })).rejects.toThrow(
      ModelUnavailableError,
    );
    expect(fake.seen).toHaveLength(0);
    await client({ vision: true }).chat({ ...request, images: [image] });
    const messages = fake.seen[0]?.body?.["messages"] as { role: string; content: unknown }[];
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toEqual([
      { type: "text", text: "user text" },
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}` },
      },
    ]);
  });

  it("never sends audio", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer("{}")));
    await expect(client().chat({ ...request, audio: [new Uint8Array([1])] })).rejects.toThrow(
      ModelUnavailableError,
    );
    expect(fake.seen).toHaveLength(0);
  });

  it("an answer it cannot read is Gemma offline", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => ({ choices: [] })));
    await expect(client().chat(request)).rejects.toThrow(/cannot read/);
  });
});

describe("AC-032.2: the outbound allowlist", () => {
  it("allows the inference host only", () => {
    expect(DIGITALOCEAN_ALLOWED_HOSTS).toEqual(["inference.do-ai.run"]);
    expect(() => {
      assertInferenceUrl(`${DIGITALOCEAN_INFERENCE_URL}/v1/models`);
    }).not.toThrow();
    for (const url of [
      "https://example.com/v1/models",
      "https://inference.do-ai.run.evil.example/v1/models",
      "https://evil.example/inference.do-ai.run",
      "http://inference.do-ai.run/v1/models",
      "https://inference.do-ai.run:8443/v1/models",
      "https://user:pass@inference.do-ai.run/v1/models",
      "https://api.open-meteo.com/v1/forecast",
      "http://127.0.0.1:11434/api/chat",
      "not a url",
    ]) {
      expect(() => {
        assertInferenceUrl(url);
      }, url).toThrow(DisallowedInferenceHostError);
    }
  });

  it("a client for any other host cannot be built, so no request can leave for it", () => {
    for (const baseUrl of [
      "https://evil.example",
      "http://127.0.0.1:9",
      "https://api.open-meteo.com",
    ]) {
      expect(() => client({ baseUrl }, undefined)).toThrow(DisallowedInferenceHostError);
    }
  });

  it("refuses a redirect, so the key cannot follow one to another host", async () => {
    fake = await startFakeDigitalOcean((_request, response) => {
      response.writeHead(307, { location: "https://evil.example/steal" });
      response.end();
    });
    await expect(client().chat(request)).rejects.toThrow(ModelUnavailableError);
    expect(fake.seen).toHaveLength(1);
  });
});

describe("AC-032.2: the key never appears in an error, a log or an answer", () => {
  it("strips the key and the prompt from an upstream error body", async () => {
    fake = await startFakeDigitalOcean((incoming, response) => {
      json(response, 500, {
        error: {
          message: `bad request for key ${KEY}: ${incoming.text}`,
          code: "invalid_request",
        },
      });
    });
    const failure = await client()
      .chat({ ...request, messages: [{ role: "user", content: "my secret chore text" }] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelUnavailableError);
    const text = `${String(failure)} ${JSON.stringify(failure)} ${(failure as Error).stack ?? ""}`;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("my secret chore text");
    expect(text).toContain("500");
    expect(text).toContain("invalid_request");
  });

  it("redacts the key from a transport failure message", async () => {
    const failing: typeof fetch = () =>
      Promise.reject(
        new TypeError(`fetch failed for Bearer ${KEY}`, { cause: new Error(`oops ${KEY}`) }),
      );
    const failure = await client({ fetch: failing }, undefined)
      .chat(request)
      .catch((error: unknown) => error);
    expect(String(failure)).not.toContain(KEY);
    expect((failure as Error).cause).toBeUndefined();
  });

  it("names a refused key without the key", async () => {
    fake = await startFakeDigitalOcean((_request, response) => {
      json(response, 401, { error: { message: `Invalid key ${KEY}` } });
    });
    await expect(client().chat(request)).rejects.toThrow("refused the inference key (HTTP 401)");
    const health = await client().health();
    expect(health.state).toBe("offline");
    expect(JSON.stringify(health)).not.toContain(KEY);
  });

  it("a Secret prints as [redacted] however it is shown", () => {
    const secret = new Secret(KEY);
    expect(String(secret)).toBe("[redacted]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(`${JSON.stringify(secret)}`).not.toContain(KEY);
    expect(secret.redact(`a ${KEY} b ${KEY}`)).toBe("a [redacted] b [redacted]");
  });
});

describe("timeouts and health", () => {
  it("times out with ModelTimeoutError after the per-call timeout", async () => {
    fake = await startFakeDigitalOcean(() => {
      // never answers
    });
    await expect(client().chat({ ...request, timeoutMs: 50 })).rejects.toThrow(ModelTimeoutError);
  });

  it("health lists /v1/models, needs no generation and never throws", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer("{}")));
    expect(await client().health()).toEqual({ state: "online", detail: MODEL_ID });
    expect(fake.seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual(["GET /v1/models"]);
    expect((await client({ model: "gemma-4-other" }).health()).state).toBe("offline");
    await fake.close();
    const down = await client({ healthTimeoutMs: 200 }).health();
    expect(down.state).toBe("offline");
    fake = undefined;
  });

  it("warmUp is the same cheap check", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer("{}")));
    expect((await client().warmUp()).state).toBe("online");
    expect(fake.seen).toHaveLength(1);
  });
});
