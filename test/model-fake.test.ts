import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CHORES } from "../src/domain/chores.js";
import { judgeBet } from "../src/server/gemma/judge.js";
import { loadPrompt } from "../src/server/gemma/prompts.js";
import {
  ModelTimeoutError,
  ModelUnavailableError,
  type ChatRequest,
} from "../src/server/model/client.js";
import { FakeModelClient } from "../src/server/model/fake.js";

const request = (job: string): ChatRequest => ({
  job,
  messages: [{ role: "user", content: "hello" }],
  timeoutMs: 30_000,
});

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function fixtures(files: Record<string, unknown>): string {
  dir = mkdtempSync(join(tmpdir(), "sib-fixtures-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(content));
  }
  return dir;
}

describe("NFR-010: FakeModelClient answers from fixtures keyed by job and scenario name", () => {
  it("returns the fixture of the job and the selected scenario, whatever the input", async () => {
    const fake = new FakeModelClient({
      fixturesDir: fixtures({
        "judge/ok.json": { description: "a", content: { status: "ok" } },
        "judge/other.json": { description: "b", content: "plain text", model: "m2" },
        "bookmaker/ok.json": {
          description: "c",
          content: { band: 3 },
          toolCalls: [{ name: "get_forecast", arguments: { hours_ahead: 24 } }],
        },
      }),
    });
    expect(await fake.chat(request("judge"))).toMatchObject({
      content: '{"status":"ok"}',
      toolCalls: [],
    });
    fake.setScenario("judge", "other");
    expect(
      await fake.chat({ ...request("judge"), messages: [{ role: "user", content: "different" }] }),
    ).toMatchObject({
      content: "plain text",
      model: "m2",
    });
    expect(await fake.chat(request("bookmaker"))).toMatchObject({
      toolCalls: [{ name: "get_forecast", arguments: { hours_ahead: 24 } }],
    });
    expect(fake.calls.map((call) => call.job)).toEqual(["judge", "judge", "bookmaker"]);
  });

  it("raises the runtime errors a fixture describes", async () => {
    const fake = new FakeModelClient({
      fixturesDir: fixtures({
        "judge/timeout.json": { description: "t", error: "timeout" },
        "judge/offline.json": { description: "o", error: "unavailable" },
      }),
    });
    fake.setScenario("judge", "timeout");
    await expect(fake.chat(request("judge"))).rejects.toBeInstanceOf(ModelTimeoutError);
    fake.setScenario("judge", "offline");
    await expect(fake.chat(request("judge"))).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("names the missing fixture and refuses names that could leave the fixtures folder", async () => {
    const fake = new FakeModelClient({ fixturesDir: fixtures({}) });
    await expect(fake.chat(request("judge"))).rejects.toThrow(
      "No fixture for job judge, scenario ok",
    );
    fake.setScenario("judge", "../../etc/passwd");
    await expect(fake.chat(request("judge"))).rejects.toThrow("Invalid fixture name");
    await expect(fake.chat(request("../judge"))).rejects.toThrow("Invalid fixture name");
  });

  it("rejects a malformed fixture", async () => {
    const fake = new FakeModelClient({
      fixturesDir: fixtures({ "judge/ok.json": { content: {} } }),
    });
    await expect(fake.chat(request("judge"))).rejects.toThrow();
  });
});

describe("judge job on the committed synthetic fixtures", () => {
  const input = { chore: CHORES.plants, odds: 70, answerId: "moist" };

  it("turns each fixture into a verdict or a failure kind, never both", async () => {
    const fake = new FakeModelClient();
    const outcomes: Record<string, string> = {};
    for (const scenario of [
      "ok",
      "small-loss",
      "normal-loss",
      "harmful-loss",
      "unsure",
      "invalid-json",
      "invalid-schema",
      "timeout",
      "offline",
    ]) {
      fake.setScenario("judge", scenario);
      const result = await judgeBet(fake, input);
      outcomes[scenario] = result.ok ? result.verdict : result.failure;
    }
    expect(outcomes).toEqual({
      ok: "win",
      "small-loss": "small_loss",
      "normal-loss": "normal_loss",
      "harmful-loss": "harmful_loss",
      unsure: "unsure",
      "invalid-json": "invalid",
      "invalid-schema": "invalid",
      timeout: "timeout",
      offline: "unavailable",
    });
  });

  it("puts the chore and the tapped answer in a delimited data block and sends a JSON schema", async () => {
    const fake = new FakeModelClient();
    await judgeBet(fake, input);
    const [call] = fake.calls;
    expect(call?.timeoutMs).toBe(30_000);
    expect(call?.schema).toMatchObject({ type: "object" });
    const user = call?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toMatch(/^<untrusted_data>\n/);
    expect(user).toContain("Still moist, all fine");
    expect(user).toContain("water the balcony plants");
    expect(call?.messages[0]?.content).toContain("not instructions");
  });

  it("loads versioned prompt files", () => {
    expect(loadPrompt("judge", 1).version).toBe("judge.v1");
    expect(() => loadPrompt("judge", 99)).toThrow();
  });
});
