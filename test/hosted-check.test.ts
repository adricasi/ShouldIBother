import { afterEach, describe, expect, it } from "vitest";

import { hostedCheckCommand, runHostedChecks } from "../src/server/model/hosted-check.js";
import { parseModeSettings, type HostedSettings } from "../src/server/mode.js";

import {
  KEY,
  MODEL_ID,
  chatAnswer,
  json,
  startFakeDigitalOcean,
  type FakeDigitalOcean,
  type Handler,
} from "./support/fake-digitalocean.js";

let fake: FakeDigitalOcean | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const ENV = {
  SIB_MODE: "hosted",
  SIB_PUBLIC_ORIGIN: "https://sib.example.com",
  SIB_DO_MODEL: MODEL_ID,
  SIB_DO_INFERENCE_KEY: KEY,
};

function settings(): HostedSettings {
  const parsed = parseModeSettings(ENV);
  if (parsed.mode !== "hosted") {
    throw new Error("expected hosted settings");
  }
  return parsed;
}

interface Capabilities {
  readonly models?: string[];
  readonly json?: boolean;
  readonly tools?: boolean;
  readonly images?: boolean;
}

/** A service with the given capabilities. */
function service(capabilities: Capabilities = {}): Handler {
  const { models = [MODEL_ID], json: validJson = true, tools = true, images = true } = capabilities;
  return (request, response) => {
    if (request.url === "/v1/models") {
      json(response, 200, { data: models.map((id) => ({ id })) });
      return;
    }
    const body = request.body as {
      tools?: unknown;
      response_format?: unknown;
      messages: { content: unknown }[];
    };
    if (JSON.stringify(body).includes("image_url")) {
      if (images) {
        json(response, 200, chatAnswer("red"));
      } else {
        json(response, 400, {
          error: { message: "images are not supported", code: "unsupported" },
        });
      }
    } else if (body.tools !== undefined) {
      json(
        response,
        200,
        tools
          ? chatAnswer(null, [{ name: "get_forecast", arguments: { hours_ahead: 6 } }])
          : chatAnswer("It might rain."),
      );
    } else {
      json(response, 200, chatAnswer(validJson ? '{"ok": true}' : "Sure, it is fine."));
    }
  };
}

describe("AC-032.8: sib hosted-check", () => {
  it("runs the four checks, one call each, and reports a pass for each", async () => {
    fake = await startFakeDigitalOcean(service());
    const results = await runHostedChecks(settings(), { fetch: fake.fetch });
    expect(results.map((result) => [result.check, result.ok])).toEqual([
      ["model listed", true],
      ["JSON answer", true],
      ["tool call", true],
      ["image accepted", true],
    ]);
    expect(fake.seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
      "POST /v1/chat/completions",
      "POST /v1/chat/completions",
    ]);
  });

  it("sends a tiny synthetic PNG and no household data", async () => {
    fake = await startFakeDigitalOcean(service());
    await runHostedChecks(settings(), { fetch: fake.fetch });
    const imageCall = fake.seen.find((entry) => entry.text.includes("image_url"));
    const url = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(imageCall?.text ?? "")?.[1] ?? "";
    const png = Buffer.from(url, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.length).toBeLessThan(500);
    const everything = fake.seen.map((entry) => entry.text).join("\n");
    expect(everything).not.toMatch(/plant|balcony|laundry|household/i);
  });

  it("says use injected tool use when no tool call comes back", async () => {
    fake = await startFakeDigitalOcean(service({ tools: false }));
    const results = await runHostedChecks(settings(), { fetch: fake.fetch });
    const tool = results.find((result) => result.check === "tool call");
    expect(tool?.ok).toBe(false);
    expect(tool?.detail).toContain("Use injected tool use");
  });

  it("says keep SIB_DO_VISION off when the image is refused", async () => {
    fake = await startFakeDigitalOcean(service({ images: false }));
    const results = await runHostedChecks(settings(), { fetch: fake.fetch });
    const image = results.find((result) => result.check === "image accepted");
    expect(image?.ok).toBe(false);
    expect(image?.detail).toContain("Keep SIB_DO_VISION off");
    expect(image?.detail).toContain("(unsupported)");
  });

  it("lists the Gemma models when the one in SIB_DO_MODEL is not there", async () => {
    fake = await startFakeDigitalOcean(service({ models: ["gemma-4-26B-A4B-it", "llama-3-8b"] }));
    const [listed] = await runHostedChecks(settings(), { fetch: fake.fetch });
    expect(listed?.ok).toBe(false);
    expect(listed?.detail).toContain("gemma-4-26B-A4B-it");
    expect(listed?.detail).not.toContain("llama-3-8b");
  });

  it("fails the JSON check on an answer that is not the schema's", async () => {
    fake = await startFakeDigitalOcean(service({ json: false }));
    const results = await runHostedChecks(settings(), { fetch: fake.fetch });
    expect(results.find((result) => result.check === "JSON answer")?.ok).toBe(false);
  });

  it("prints a table without the key and exits 0 when the model and JSON work, 1 when not", async () => {
    fake = await startFakeDigitalOcean(service({ tools: false, images: false }));
    const lines: string[] = [];
    const ok = await hostedCheckCommand(ENV, (line) => lines.push(line), { fetch: fake.fetch });
    expect(ok).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/PASS\s+model listed/);
    expect(text).toMatch(/FAIL\s+tool call/);
    expect(text).toContain("Record these results in docs/adr/0011");
    expect(text).not.toContain(KEY);

    const broken: string[] = [];
    await fake.close();
    fake = await startFakeDigitalOcean(service({ models: ["llama-3-8b"] }));
    expect(await hostedCheckCommand(ENV, (line) => broken.push(line), { fetch: fake.fetch })).toBe(
      1,
    );
    expect(broken.join("\n")).not.toContain(KEY);
  });

  it("needs the hosted settings, and names what is missing without the key", async () => {
    const lines: string[] = [];
    expect(await hostedCheckCommand({}, (line) => lines.push(line))).toBe(1);
    expect(lines.join("\n")).toContain("SIB_MODE=hosted");
    const missing: string[] = [];
    expect(await hostedCheckCommand({ SIB_MODE: "hosted" }, (line) => missing.push(line))).toBe(1);
    expect(missing.join("\n")).toContain("SIB_DO_INFERENCE_KEY is required");
  });
});
