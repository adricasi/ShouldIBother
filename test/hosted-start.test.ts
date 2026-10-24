import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_DIR } from "../src/server/config.js";
import { pairCommand, startServer, type RunningServer } from "../src/server/main.js";

import {
  KEY,
  MODEL_ID,
  chatAnswer,
  json,
  startFakeDigitalOcean,
  wellBehaved,
  type FakeDigitalOcean,
  type Recorded,
} from "./support/fake-digitalocean.js";
import { syntheticPhoto, multipartBody } from "./support/photos.js";

/*
 * main.ts in hosted mode (REQ-032) on its real path: the settings, the DigitalOcean client against
 * a fake inference server on 127.0.0.1 (no network), the cap, the photo gate, and home mode
 * beside it, unchanged.
 */

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

const ORIGIN = "https://sib.example.com";
const HOST = "sib.example.com";
const BOOKMAKER_ANSWER = JSON.stringify({
  status: "ok",
  band: "unlikely",
  reason: "Little rain is due, so skipping it is a fair bet.",
  settle_in_hours: 14,
});

let dir: string;
let fake: FakeDigitalOcean | undefined;
let running: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sib-hosted-"));
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  await fake?.close();
  fake = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function configure(flags: Record<string, boolean> = {}): string {
  const configDir = join(dir, "config") + "/";
  mkdirSync(configDir);
  writeFileSync(`${configDir}flags.json`, JSON.stringify(flags));
  // No model tag: hosted mode needs none, and must not ask for one.
  writeFileSync(`${configDir}models.json`, "{}");
  for (const name of ["server.example.json", "household.example.json"]) {
    copyFileSync(`${CONFIG_DIR}${name}`, `${configDir}${name}`);
  }
  return configDir;
}

const dataDir = (): string => join(dir, "data");

function hostedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    SIB_DATA_DIR: dataDir(),
    SIB_FAKE_WEATHER: "1",
    SIB_MODE: "hosted",
    SIB_PUBLIC_ORIGIN: ORIGIN,
    SIB_DO_MODEL: MODEL_ID,
    SIB_DO_INFERENCE_KEY: KEY,
    SIB_BIND_ADDRESS: "127.0.0.1",
    ...extra,
  };
}

interface Started {
  readonly server: RunningServer;
  readonly lines: string[];
}

async function start(
  env: Record<string, string>,
  flags: Record<string, boolean> = {},
): Promise<Started> {
  const lines: string[] = [];
  const port = await freePort();
  const server = await startServer(
    { ...env, SIB_PORT: String(port) },
    {
      configDir: configure(flags),
      output: (line) => lines.push(line),
      ...(fake === undefined ? {} : { fetch: fake.fetch }),
    },
  );
  running = server;
  return { server, lines };
}

/** Pairs a device the hosted way: a token from `sib pair`, then the POST of the pairing page. */
async function pairHosted(server: RunningServer): Promise<string> {
  const { token } = server.runtime.store.issuePairingToken();
  const response = await server.app.inject({
    method: "POST",
    url: "/pair",
    headers: { host: HOST, origin: ORIGIN },
    payload: { token },
  });
  expect(response.statusCode).toBe(204);
  return String(response.headers["set-cookie"]).split(";")[0] ?? "";
}

const getJson = async <T>(server: RunningServer, cookie: string, url: string): Promise<T> =>
  (await server.app.inject({ url, headers: { host: HOST, cookie } })).json<T>();

const post = (server: RunningServer, cookie: string, url: string, payload: unknown = {}) =>
  server.app.inject({
    method: "POST",
    url,
    headers: { host: HOST, origin: ORIGIN, cookie },
    payload: payload as object,
  });

const chats = (): Recorded[] => (fake?.seen ?? []).filter((entry) => entry.url.includes("chat"));

describe("AC-032.1, AC-032.2: refusing to start", () => {
  it("refuses an unknown SIB_MODE before anything is opened", async () => {
    await expect(
      startServer({ SIB_MODE: "production", SIB_DATA_DIR: dataDir() }, { configDir: configure() }),
    ).rejects.toThrow("SIB_MODE must be home or hosted");
    expect(existsSync(dataDir())).toBe(false);
  });

  it("refuses hosted mode with a missing or invalid setting, naming it and never the key", async () => {
    for (const [env, text] of [
      [{ SIB_PUBLIC_ORIGIN: "http://sib.example.com" }, "SIB_PUBLIC_ORIGIN must be an https://"],
      [{ SIB_DO_MODEL: "llama-3" }, "SIB_DO_MODEL must be a Gemma 4 model ID"],
      [{ SIB_DO_INFERENCE_KEY: "" }, "SIB_DO_INFERENCE_KEY is required"],
      [{ SIB_DAILY_MODEL_CALLS: "0" }, "SIB_DAILY_MODEL_CALLS must be a positive"],
    ] as const) {
      const failure = await startServer(
        { ...hostedEnv(), ...env },
        { configDir: configure() },
      ).catch((error: unknown) => error);
      expect((failure as Error).message, text).toContain(text);
      expect((failure as Error).message).not.toContain(KEY);
      expect(existsSync(dataDir())).toBe(false);
      rmSync(join(dir, "config"), { recursive: true });
    }
  });
});

describe("AC-032.1: home mode is unchanged and ignores the hosted settings", () => {
  it("prints the pairing link, accepts the laptop's Host and says photos are on", async () => {
    const { server, lines } = await start({
      SIB_DATA_DIR: dataDir(),
      SIB_FAKE_WEATHER: "1",
      SIB_FAKE_MODEL: "1",
    });
    const text = lines.join("\n");
    expect(text).toContain("/pair?token=");
    expect(text).not.toContain("#t=");
    expect(server.runtime.mode).toEqual({ mode: "home" });
    const port = server.runtime.port;
    const { token } = server.runtime.store.issuePairingToken();
    const paired = await server.app.inject({
      url: `/pair?token=${token}`,
      headers: { host: `localhost:${port}` },
    });
    expect(paired.statusCode).toBe(303);
    expect(String(paired.headers["set-cookie"])).toMatch(/^sib_session=/);
    const cookie = String(paired.headers["set-cookie"]).split(";")[0] ?? "";
    const today = (
      await server.app.inject({ url: "/api/today", headers: { host: `localhost:${port}`, cookie } })
    ).json<{ mode: string; photos: boolean; flags: Record<string, boolean> }>();
    expect(today).toMatchObject({ mode: "home", photos: true });
    // The hosted public host is not an allowed Host in home mode.
    const other = await server.app.inject({ url: "/pair", headers: { host: HOST } });
    expect(other.statusCode).toBe(421);
  });

  it("warns once, naming each hosted variable that is set, and ignores them", async () => {
    const { server, lines } = await start({
      SIB_DATA_DIR: dataDir(),
      SIB_FAKE_WEATHER: "1",
      SIB_FAKE_MODEL: "1",
      SIB_PUBLIC_ORIGIN: "http://not-checked",
      SIB_DO_INFERENCE_KEY: KEY,
      SIB_DAILY_MODEL_CALLS: "nonsense",
    });
    const warning = lines.filter((line) => line.startsWith("Home mode:"));
    expect(warning).toHaveLength(1);
    expect(warning[0]).toContain("SIB_PUBLIC_ORIGIN, SIB_DO_INFERENCE_KEY, SIB_DAILY_MODEL_CALLS");
    expect(lines.join("\n")).not.toContain(KEY);
    expect(server.runtime.ignoredHostedVariables).toEqual([
      "SIB_PUBLIC_ORIGIN",
      "SIB_DO_INFERENCE_KEY",
      "SIB_DAILY_MODEL_CALLS",
    ]);
  });
});

describe("AC-032.2, AC-032.3: hosted start-up", () => {
  it("starts without a model tag, makes no pairing token and prints no link", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer(BOOKMAKER_ANSWER)));
    const { server, lines } = await start(hostedEnv());
    const text = lines.join("\n");
    expect(text).not.toContain("token=");
    expect(text).not.toContain("#t=");
    expect(text).toContain("No pairing link is made at start. Run `sib pair`");
    expect(text).toContain(`Public origin: ${ORIGIN}`);
    expect(text).toContain(MODEL_ID);
    expect(text).toContain("inference.do-ai.run");
    expect(text).not.toContain(KEY);
    expect(server.runtime.db.prepare("SELECT COUNT(*) AS n FROM pairing").get()).toEqual({ n: 0 });
    expect(server.runtime.lanAddress).toBeUndefined();
    // Only the cheap model list was asked at start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chats()).toHaveLength(0);
  });

  it("sib pair prints the link with the token in the fragment", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer(BOOKMAKER_ANSWER)));
    const { server } = await start(hostedEnv());
    const printed: string[] = [];
    pairCommand({ ...server.runtime, db: server.runtime.db }, (line) => printed.push(line));
    const text = printed.join("\n");
    expect(text).toMatch(new RegExp(`${ORIGIN}/pair#t=[A-Za-z0-9_-]{43}`));
    expect(text).not.toContain("?token=");
    // The command closes the database it was given; the test server has no more use for it.
    running = undefined;
    await server.app.close().catch(() => undefined);
  });

  it("reports the mode, photos off and the model ID, with voice and the fine-tune forced off", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer(BOOKMAKER_ANSWER)));
    const { server } = await start(hostedEnv(), { voice: true, finetunedBookmaker: true });
    const cookie = await pairHosted(server);
    const today = await getJson<{
      mode: string;
      photos: boolean;
      flags: Record<string, boolean>;
      gemma: { status: string; detail: string };
    }>(server, cookie, "/api/today");
    expect(today.mode).toBe("hosted");
    expect(today.photos).toBe(false);
    expect(today.flags["voice"]).toBe(false);
    expect(today.flags["finetunedBookmaker"]).toBe(false);
    expect(today.gemma).toMatchObject({ status: "online", detail: MODEL_ID });
    expect((await post(server, cookie, "/api/voice")).statusCode).toBe(404);
  });
});

describe("AC-032.2: Gemma through the inference API", () => {
  it("prices a card with the injected tool result, no tools list and the bearer key", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer(BOOKMAKER_ANSWER)));
    const { server } = await start(hostedEnv());
    const cookie = await pairHosted(server);
    const created = (
      await post(server, cookie, "/api/cards/quick", { chore_type: "plants" })
    ).json<{
      id: number;
    }>();
    await waitFor(async () => {
      const card = await getJson<{ quote: { source: string } | null }>(
        server,
        cookie,
        `/api/cards/${created.id}`,
      );
      expect(card.quote?.source).toBe("gemma");
    });
    const [call] = chats();
    expect(call?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    const body = call?.body as { model: string; messages: { role: string; content: string }[] };
    expect(body.model).toBe(MODEL_ID);
    expect(body).not.toHaveProperty("tools");
    expect(body.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages[3]?.content).toContain("Result of get_forecast:");
    const decision = server.runtime.db
      .prepare("SELECT model, tool_mode, error FROM gemma_decisions ORDER BY id")
      .all() as { model: string; tool_mode: string }[];
    expect(decision[0]).toMatchObject({ model: MODEL_ID, tool_mode: "injected" });
    // The key is in no row, no answer of the API, no console line.
    const everything = JSON.stringify([
      server.runtime.db.prepare("SELECT * FROM gemma_decisions").all(),
      await getJson(server, cookie, "/api/today"),
      await getJson(server, cookie, "/api/slips"),
    ]);
    expect(everything).not.toContain(KEY);
  });

  it("SIB_TOOL_USE=native lets Gemma call get_forecast itself", async () => {
    let chatCalls = 0;
    fake = await startFakeDigitalOcean((request, response) => {
      if (request.url === "/v1/models") {
        json(response, 200, { data: [{ id: MODEL_ID }] });
        return;
      }
      chatCalls += 1;
      json(
        response,
        200,
        chatCalls === 1
          ? chatAnswer(null, [{ name: "get_forecast", arguments: { hours_ahead: 24 } }])
          : chatAnswer(BOOKMAKER_ANSWER),
      );
    });
    const { server } = await start(hostedEnv({ SIB_TOOL_USE: "native" }));
    const cookie = await pairHosted(server);
    await post(server, cookie, "/api/cards/quick", { chore_type: "plants" });
    await waitFor(() => {
      expect(chats()).toHaveLength(2);
    });
    expect(chats()[0]?.body).toHaveProperty("tools");
    const second = chats()[1]?.body as { messages: { role: string }[] };
    expect(second.messages.map((message) => message.role)).toContain("tool");
    await waitFor(() => {
      const row = server.runtime.db.prepare("SELECT tool_mode FROM gemma_decisions").get() as
        { tool_mode: string } | undefined;
      expect(row?.tool_mode).toBe("called");
    });
  });

  it("SIB_FAKE_MODEL=1 still wins, for tests and the demo: no call reaches the service", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer(BOOKMAKER_ANSWER)));
    const { server, lines } = await start(hostedEnv({ SIB_FAKE_MODEL: "1" }));
    expect(lines.join("\n")).toContain("FAKE MODEL");
    const cookie = await pairHosted(server);
    await post(server, cookie, "/api/cards/quick", { chore_type: "plants" });
    await server.app.ready();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.seen).toHaveLength(0);
  });

  it("Gemma offline when the service is down: the app still starts and cards keep rule odds", async () => {
    fake = await startFakeDigitalOcean((_request, response) => {
      json(response, 503, { error: { message: "down" } });
    });
    const { server, lines } = await start(hostedEnv());
    expect(lines.join("\n")).toContain("is not usable yet");
    const cookie = await pairHosted(server);
    const created = (
      await post(server, cookie, "/api/cards/quick", { chore_type: "plants" })
    ).json<{
      id: number;
    }>();
    await waitFor(async () => {
      const card = await getJson<{ quote: { source: string }; gemma: { state: string } }>(
        server,
        cookie,
        `/api/cards/${created.id}`,
      );
      expect(card.gemma.state).toBe("offline");
      expect(card.quote.source).toBe("rule");
    });
  });
});

describe("AC-032.5: the daily cap through the app", () => {
  it("over the cap a card keeps rule odds and says Gemma's daily limit, with no request sent", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer(BOOKMAKER_ANSWER)));
    const { server } = await start(hostedEnv({ SIB_DAILY_MODEL_CALLS: "1" }));
    const cookie = await pairHosted(server);
    const created = (
      await post(server, cookie, "/api/cards/quick", { chore_type: "plants" })
    ).json<{
      id: number;
    }>();
    await waitFor(async () => {
      const card = await getJson<{ gemma: { state: string; note: string } }>(
        server,
        cookie,
        `/api/cards/${created.id}`,
      );
      expect(card.gemma).toMatchObject({
        state: "offline",
        note: "Gemma's daily limit · rule odds",
      });
    });
    expect(chats()).toHaveLength(0);
  });
});

describe("AC-032.4: photos only with SIB_DO_VISION=1", () => {
  async function uploadTo(server: RunningServer, cookie: string, cardId: number) {
    const body = multipartBody(await syntheticPhoto(), {});
    return server.app.inject({
      method: "POST",
      url: `/api/cards/${cardId}/photo`,
      payload: body.payload,
      headers: { host: HOST, origin: ORIGIN, cookie, ...body.headers },
    });
  }

  it("refuses an upload with 409, runs no inspector and sends nothing to the model", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer(BOOKMAKER_ANSWER)));
    const { server } = await start(hostedEnv());
    const cookie = await pairHosted(server);
    const created = (
      await post(server, cookie, "/api/cards/quick", { chore_type: "plants" })
    ).json<{
      id: number;
    }>();
    await waitFor(() => {
      expect(chats().length).toBeGreaterThan(0);
    });
    const before = chats().length;
    const refused = await uploadTo(server, cookie, created.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.headers["content-type"]).toContain("application/problem+json");
    expect(refused.json<{ title: string }>().title).toBe("Photos are off on this server");
    expect(server.runtime.db.prepare("SELECT COUNT(*) AS n FROM photos").get()).toEqual({ n: 0 });
    expect(chats()).toHaveLength(before);
    // The after photo of a settlement and an appeal are refused the same way.
    const settle = multipartBody(await syntheticPhoto(), {});
    const answer = await server.app.inject({
      method: "POST",
      url: "/api/bets/1/settle",
      payload: settle.payload,
      headers: { host: HOST, origin: ORIGIN, cookie, ...settle.headers },
    });
    expect(answer.statusCode).toBe(409);
  });

  it("takes the upload and sends the photo as an image when SIB_DO_VISION=1", async () => {
    fake = await startFakeDigitalOcean(wellBehaved(() => chatAnswer(BOOKMAKER_ANSWER)));
    const { server } = await start(hostedEnv({ SIB_DO_VISION: "1" }));
    const cookie = await pairHosted(server);
    const today = await getJson<{ photos: boolean }>(server, cookie, "/api/today");
    expect(today.photos).toBe(true);
    const created = (
      await post(server, cookie, "/api/cards/quick", { chore_type: "plants" })
    ).json<{
      id: number;
    }>();
    await waitFor(async () => {
      const card = await getJson<{ quote: { source: string } | null }>(
        server,
        cookie,
        `/api/cards/${created.id}`,
      );
      expect(card.quote?.source).toBe("gemma");
    });
    const accepted = await uploadTo(server, cookie, created.id);
    expect(accepted.statusCode).toBe(201);
    await waitFor(() => {
      expect(chats().some((entry) => entry.text.includes("image_url"))).toBe(true);
    });
  });
});

/** Polls `check` until it stops throwing (background Gemma steps finish after the response). */
async function waitFor(check: () => unknown, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
