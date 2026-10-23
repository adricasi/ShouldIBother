import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_DIR } from "../src/server/config.js";
import { startServer, type RunningServer } from "../src/server/main.js";
import type { ChatRequest, ChatResponse } from "../src/server/model/client.js";
import {
  FINETUNED_MODEL_KEY,
  finetunedModelTag,
  parseModelsConfig,
} from "../src/server/model/config.js";
import { FakeModelClient } from "../src/server/model/fake.js";
import { OllamaClient } from "../src/server/model/ollama.js";
import { selectModel } from "../src/server/model/select.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { cookieHeaderFrom } from "./helpers.js";
import { startFakeRuntime, type FakeRuntime } from "./support/fake-runtime.js";

const BASE_TAG = "gemma4:e4b";
const FT_TAG = "gemma4-bookmaker-ft:e4b";

/** A fake model that answers as another model, the way Ollama reports the tag that ran. */
class NamedFakeModel extends FakeModelClient {
  constructor(
    private readonly name: string,
    private readonly digest: string,
  ) {
    super();
  }
  override async chat(request: ChatRequest): Promise<ChatResponse> {
    return { ...(await super.chat(request)), model: this.name, modelDigest: this.digest };
  }
}

describe("config: the fine-tuned entry", () => {
  it("lives at models.e4b-ft, the key the backtest uses, and is absent until training adds it", () => {
    expect(FINETUNED_MODEL_KEY).toBe("e4b-ft");
    expect(finetunedModelTag(parseModelsConfig({}))).toBeUndefined();
    expect(finetunedModelTag(parseModelsConfig({ models: { "e4b-ft": { tag: FT_TAG } } }))).toBe(
      FT_TAG,
    );
  });
});

describe("AC-019.4: the fine-tuned model prices the cards and its version is recorded", () => {
  let harness: CoreHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function priceOneCard(): Promise<{
    h: CoreHarness;
    primary: FakeModelClient;
    ft: FakeModelClient;
  }> {
    const primary = new FakeModelClient();
    const ft = new NamedFakeModel(FT_TAG, "sha256:synthetic-ft");
    ft.setScenario("bookmaker", "ok");
    harness = await createCoreHarness({
      model: primary,
      weatherProfile: FAKE_WEATHER_PROFILES.mild,
      runner: { jobModels: { bookmaker: ft } },
    });
    await pair(harness);
    const created = await harness.post("/api/cards/quick", { chore_type: "plants" });
    expect(created.statusCode).toBe(201);
    await harness.idle();
    return { h: harness, primary, ft };
  }

  it("sends the bookmaker job to the fine-tuned model and no other job", async () => {
    const { primary, ft } = await priceOneCard();
    expect(ft.calls.map((call) => call.job).every((job) => job === "bookmaker")).toBe(true);
    expect(ft.calls.length).toBeGreaterThan(0);
    expect(primary.calls.some((call) => call.job === "bookmaker")).toBe(false);
  });

  it("keeps the other jobs on the primary model (the typed-capture listener)", async () => {
    const { h, primary, ft } = await priceOneCard();
    const typed = await h.post("/api/cards", { text: "water the tomatoes" });
    expect(typed.statusCode).toBe(201);
    await h.idle();
    expect(primary.calls.map((call) => call.job)).toEqual(["listener"]);
    expect(ft.calls.every((call) => call.job === "bookmaker")).toBe(true);
  });

  it("the decision log records which model answered, and a bet records its version", async () => {
    const { h } = await priceOneCard();
    const decisions = h.db
      .prepare<[], { job: string; model: string; model_digest: string | null }>(
        "SELECT job, model, model_digest FROM gemma_decisions",
      )
      .all();
    expect(decisions).toEqual([
      { job: "bookmaker", model: FT_TAG, model_digest: "sha256:synthetic-ft" },
    ]);
    const card = (await h.get("/api/today")).json<{
      cards: { id: number; quote: { id: number } }[];
    }>().cards[0]!;
    const bet = await h.post("/api/bets", {
      card_id: card.id,
      quote_id: card.quote.id,
      kind: "do_nothing",
    });
    expect(bet.statusCode).toBe(201);
    expect(h.db.prepare("SELECT odds_source, model_version FROM bets").get()).toEqual({
      odds_source: "gemma",
      model_version: `${FT_TAG}@sha256:synthetic-ft`,
    });
  });
});

describe("selectModel with the finetunedBookmaker flag", () => {
  const withEntry = parseModelsConfig({
    models: { e4b: { tag: BASE_TAG }, "e4b-ft": { tag: FT_TAG } },
  });
  const withoutEntry = parseModelsConfig({ models: { e4b: { tag: BASE_TAG } } });

  /** An Ollama that records the model of every chat and answers the model list. */
  function recordingFetch(chatModels: string[]): typeof fetch {
    return (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/tags") {
        return Promise.resolve(
          Response.json({
            models: [
              { name: BASE_TAG, digest: "sha256:base" },
              { name: FT_TAG, digest: "sha256:ft" },
            ],
          }),
        );
      }
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        model: string;
      };
      chatModels.push(body.model);
      return Promise.resolve(Response.json({ model: body.model, message: { content: "{}" } }));
    };
  }
  const chat = (job: string) => ({
    job,
    messages: [{ role: "user" as const, content: "x" }],
    timeoutMs: 1000,
  });

  it("flag on and an entry: the bookmaker uses its tag, every other job the primary tag", async () => {
    const chatModels: string[] = [];
    const selection = await selectModel(withEntry, {
      useFake: false,
      fake: () => new FakeModelClient(),
      finetunedBookmaker: true,
      fetch: recordingFetch(chatModels),
    });
    expect(Object.keys(selection.jobModels)).toEqual(["bookmaker"]);
    expect(selection.jobModels["bookmaker"]).toBeInstanceOf(OllamaClient);
    const answered = await selection.jobModels["bookmaker"]!.chat(chat("bookmaker"));
    expect(answered).toMatchObject({ model: FT_TAG, modelDigest: "sha256:ft" });
    await selection.model.chat(chat("judge"));
    expect(chatModels).toEqual([FT_TAG, BASE_TAG]);
    expect(selection.notice).toContain(`Fine-tuned bookmaker: ${FT_TAG} prices the cards`);
  });

  it("flag off: nothing changes, even with the entry in the config", async () => {
    const selection = await selectModel(withEntry, {
      useFake: false,
      fake: () => new FakeModelClient(),
      fetch: recordingFetch([]),
    });
    expect(selection.jobModels).toEqual({});
    expect(selection.notice).not.toContain("Fine-tuned");
  });

  it("flag on but no entry: nothing changes, and the notice says why", async () => {
    const selection = await selectModel(withoutEntry, {
      useFake: false,
      fake: () => new FakeModelClient(),
      finetunedBookmaker: true,
      fetch: recordingFetch([]),
    });
    expect(selection.jobModels).toEqual({});
    expect(selection.notice).toContain("no models.e4b-ft.tag");
    expect(selection.notice).toContain(`the bookmaker uses ${BASE_TAG}`);
  });

  it("works together with the voice flag, each job to its own runtime", async () => {
    const selection = await selectModel(withEntry, {
      useFake: false,
      fake: () => new FakeModelClient(),
      finetunedBookmaker: true,
      voice: true,
      fetch: recordingFetch([]),
    });
    expect(Object.keys(selection.jobModels).sort()).toEqual(["bookmaker", "listener-audio"]);
  });

  it("the fake model ignores the flag: fixtures answer every job", async () => {
    const selection = await selectModel(withEntry, {
      useFake: true,
      fake: () => new FakeModelClient(),
      finetunedBookmaker: true,
    });
    expect(selection.jobModels).toEqual({});
  });
});

describe("main.ts wiring: the bookmaker's Ollama call carries the fine-tuned tag", () => {
  let dir: string;
  let ollama: FakeRuntime | undefined;
  let running: RunningServer | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sib-ft-wiring-"));
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
    await ollama?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => {
          resolve(port);
        });
      });
    });
  }

  /** Types one sentence; returns the model tag of each Ollama chat, by job (the bookmaker has a tool). */
  async function modelsByJob(flags: Record<string, boolean>, models: Record<string, unknown>) {
    ollama = await startFakeRuntime((url, body) => {
      if (url === "/api/tags") {
        return { models: [{ name: BASE_TAG }, { name: FT_TAG }] };
      }
      const isBookmaker = body.includes("get_forecast");
      return {
        message: {
          content: isBookmaker
            ? "{}"
            : JSON.stringify({ chores: [{ label: "water the plants", chore_type: "plants" }] }),
        },
      };
    });
    const configDir = join(dir, "config") + "/";
    mkdirSync(configDir);
    writeFileSync(`${configDir}flags.json`, JSON.stringify(flags));
    writeFileSync(
      `${configDir}models.json`,
      JSON.stringify({ primary: "e4b", ollama: { baseUrl: ollama.url }, models }),
    );
    for (const name of ["server.example.json", "household.example.json"]) {
      copyFileSync(`${CONFIG_DIR}${name}`, `${configDir}${name}`);
    }
    const port = await freePort();
    running = await startServer(
      { SIB_DATA_DIR: join(dir, "data"), SIB_FAKE_WEATHER: "1", SIB_PORT: String(port) },
      { configDir, output: () => undefined },
    );
    const { app, runtime } = running;
    const host = `localhost:${String(port)}`;
    const cookie = cookieHeaderFrom(
      await app.inject({
        method: "GET",
        url: `/pair?token=${runtime.store.issuePairingToken().token}`,
        headers: { host },
      }),
    );
    const typed = await app.inject({
      method: "POST",
      url: "/api/cards",
      payload: { text: "water the plants" },
      headers: { host, origin: `http://${host}`, cookie },
    });
    expect(typed.statusCode).toBe(201);
    // The bookmaker runs after the response; wait for its first request to reach Ollama.
    for (let waited = 0; waited < 5_000; waited += 25) {
      if (ollama.bodies.some((body) => body.includes("get_forecast"))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const seen = ollama.bodies
      .filter((body) => body.includes('"messages":[{'))
      .map((body) => {
        const parsed = JSON.parse(body) as { model: string };
        return `${body.includes("get_forecast") ? "bookmaker" : "listener"}:${parsed.model}`;
      });
    return [...new Set(seen)].sort();
  }

  it("flag on with an entry: listener on the base tag, bookmaker on the fine-tuned tag", async () => {
    expect(
      await modelsByJob(
        { finetunedBookmaker: true },
        { e4b: { tag: BASE_TAG }, "e4b-ft": { tag: FT_TAG } },
      ),
    ).toEqual([`bookmaker:${FT_TAG}`, `listener:${BASE_TAG}`]);
  });

  it("flag off, entry present: both jobs on the base tag", async () => {
    expect(await modelsByJob({}, { e4b: { tag: BASE_TAG }, "e4b-ft": { tag: FT_TAG } })).toEqual([
      `bookmaker:${BASE_TAG}`,
      `listener:${BASE_TAG}`,
    ]);
  });

  it("flag on, no entry: both jobs on the base tag", async () => {
    expect(await modelsByJob({ finetunedBookmaker: true }, { e4b: { tag: BASE_TAG } })).toEqual([
      `bookmaker:${BASE_TAG}`,
      `listener:${BASE_TAG}`,
    ]);
  });
});

describe("the fine-tuned bookmaker is warmed up and kept honest", () => {
  const config = parseModelsConfig({
    models: { e4b: { tag: BASE_TAG }, "e4b-ft": { tag: FT_TAG } },
  });

  /** An Ollama that can be switched between "everything pulled", "ft not pulled" and "down". */
  function switchableOllama() {
    const state = { down: false, ftPulled: true };
    const loads: string[] = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      if (state.down) {
        return Promise.reject(new Error("connection refused"));
      }
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/tags") {
        return Promise.resolve(
          Response.json({
            models: [
              { name: BASE_TAG, digest: "sha256:base" },
              ...(state.ftPulled ? [{ name: FT_TAG, digest: "sha256:ft" }] : []),
            ],
          }),
        );
      }
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        model: string;
        messages: unknown[];
      };
      if (body.messages.length === 0) {
        loads.push(body.model);
      }
      return Promise.resolve(Response.json({ model: body.model, message: { content: "{}" } }));
    }) as typeof fetch;
    return { state, loads, fetchImpl };
  }

  it("the warm-up loads the primary model and then the fine-tuned one, so both stay resident", async () => {
    const { loads, fetchImpl } = switchableOllama();
    const selection = await selectModel(config, {
      useFake: false,
      fake: () => new FakeModelClient(),
      finetunedBookmaker: true,
      fetch: fetchImpl,
    });
    const health = await selection.warmUp!();
    expect(loads).toEqual([BASE_TAG, FT_TAG]);
    expect(health.state).toBe("online");
  });

  it("without the flag the warm-up loads the primary model only", async () => {
    const { loads, fetchImpl } = switchableOllama();
    const selection = await selectModel(config, {
      useFake: false,
      fake: () => new FakeModelClient(),
      fetch: fetchImpl,
    });
    await selection.warmUp!();
    expect(loads).toEqual([BASE_TAG]);
  });

  it("a fine-tuned model that is not pulled shows in the warm-up result and the start notice", async () => {
    const { state, fetchImpl } = switchableOllama();
    state.ftPulled = false;
    const selection = await selectModel(config, {
      useFake: false,
      fake: () => new FakeModelClient(),
      finetunedBookmaker: true,
      fetch: fetchImpl,
    });
    expect(selection.notice).toContain(`Fine-tuned bookmaker: ${FT_TAG} is not usable yet`);
    expect(selection.notice).toContain("is not pulled");
    const health = await selection.warmUp!();
    expect(health.state).toBe("online");
    expect(health.detail).toContain("fine-tuned bookmaker:");
  });

  it("AC-019.4: a digest unknown at start (Ollama came up later) is learned before the first bookmaker call", async () => {
    const { state, fetchImpl } = switchableOllama();
    state.down = true;
    const selection = await selectModel(config, {
      useFake: false,
      fake: () => new FakeModelClient(),
      finetunedBookmaker: true,
      fetch: fetchImpl,
    });
    state.down = false;
    const answered = await selection.jobModels["bookmaker"]!.chat({
      job: "bookmaker",
      messages: [{ role: "user", content: "x" }],
      timeoutMs: 1000,
    });
    expect(answered).toMatchObject({ model: FT_TAG, modelDigest: "sha256:ft" });
  });
});

describe("the status does not read plain online while the fine-tuned bookmaker cannot answer", () => {
  let harness: CoreHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("shows a warning on Today and logs one line on the first failure", async () => {
    const ft = new NamedFakeModel(FT_TAG, "sha256:ft");
    ft.setHealth("offline");
    const logLines: string[] = [];
    harness = await createCoreHarness({
      weatherProfile: FAKE_WEATHER_PROFILES.mild,
      runner: { jobModels: { bookmaker: ft } },
      logLines,
    });
    await pair(harness);
    const gemma = async () =>
      (await harness!.get("/api/today")).json<{
        gemma: { status: string; warning?: string };
      }>().gemma;
    const first = await gemma();
    expect(first.status).toBe("online");
    expect(first.warning).toContain("The fine-tuned bookmaker is not available");
    expect(first.warning).toContain("rule odds");
    // Later checks of the same failure do not log again.
    harness.clock.advance(60_000);
    expect((await gemma()).warning).toBe(first.warning);
    const warnings = logLines.filter((line) => line.includes("gemma_model_warning"));
    expect(warnings).toHaveLength(1);

    // It clears when the model comes back, and a new failure is logged again.
    ft.setHealth("online");
    harness.clock.advance(60_000);
    expect((await gemma()).warning).toBeUndefined();
    ft.setHealth("offline");
    harness.clock.advance(60_000);
    expect((await gemma()).warning).toBeDefined();
    expect(logLines.filter((line) => line.includes("gemma_model_warning"))).toHaveLength(2);
  });

  it("shows no warning, and no key at all, when the fine-tuned model is healthy or not in use", async () => {
    harness = await createCoreHarness({
      weatherProfile: FAKE_WEATHER_PROFILES.mild,
      runner: { jobModels: { bookmaker: new NamedFakeModel(FT_TAG, "sha256:ft") } },
    });
    await pair(harness);
    const today = (await harness.get("/api/today")).json<{ gemma: Record<string, unknown> }>();
    expect("warning" in today.gemma).toBe(false);
  });
});
