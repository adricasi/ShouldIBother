import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_DIR } from "../src/server/config.js";
import { startServer, type RunningServer } from "../src/server/main.js";

import { cookieHeaderFrom } from "./helpers.js";
import { FakeOpenMeteo } from "./support/fake-open-meteo.js";
import { multipartBody, syntheticPhoto } from "./support/photos.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

let dir: string;
let server: FakeOpenMeteo;
let running: RunningServer | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sib-wiring-"));
  server = new FakeOpenMeteo(Date.now);
  await server.start();
  // The weather client reads the global fetch when it is built: this sends it to the fake server.
  // The fake server is on 127.0.0.1 and reached by the real fetch; Open-Meteo's hosts go to it.
  const realFetch = fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      .hostname === "127.0.0.1"
      ? realFetch(input, init)
      : server.transport(input, init),
  );
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("main.ts wiring: the onboarding store feeds the weather client's location (AC-024.1)", () => {
  it("a location saved in onboarding is the place the next forecast is asked for, without a restart", async () => {
    const configDir = join(dir, "config") + "/";
    // A config folder of its own: flags with onboarding on, the committed models, server and household
    // example files.
    mkdirSync(configDir);
    writeFileSync(`${configDir}flags.json`, JSON.stringify({ onboarding: true }));
    for (const name of ["models.json", "server.example.json", "household.example.json"]) {
      copyFileSync(`${CONFIG_DIR}${name}`, `${configDir}${name}`);
    }
    const port = await freePort();
    running = await startServer(
      { SIB_DATA_DIR: join(dir, "data"), SIB_FAKE_MODEL: "1", SIB_PORT: String(port) },
      { configDir, output: () => undefined },
    );
    const { app, runtime } = running;
    const host = `localhost:${String(port)}`;
    const origin = `http://${host}`;
    const { token } = runtime.store.issuePairingToken();
    const cookie = cookieHeaderFrom(
      await app.inject({ method: "GET", url: `/pair?token=${token}`, headers: { host } }),
    );
    const call = (method: "PUT" | "POST", url: string, payload: Record<string, unknown>) =>
      app.inject({ method, url, payload, headers: { host, origin, cookie } });
    const answers = (latitude: number, longitude: number) => ({
      outdoorItems: [],
      dryer: "none",
      airConditioning: false,
      heaterThisSeason: false,
      location: { latitude, longitude },
    });

    expect((await call("PUT", "/api/onboarding", answers(40.4168, -3.7038))).statusCode).toBe(200);
    expect((await call("POST", "/api/cards/quick", { chore_type: "plants" })).statusCode).toBe(201);
    expect((await call("PUT", "/api/onboarding", answers(48.8566, 2.3522))).statusCode).toBe(200);
    expect((await call("POST", "/api/cards/quick", { chore_type: "plants" })).statusCode).toBe(201);

    const places = server.forecastRequests.map(
      (url) =>
        `${url.searchParams.get("latitude") ?? ""},${url.searchParams.get("longitude") ?? ""}`,
    );
    expect(places).toEqual(["40.42,-3.7", "48.86,2.35"]);
  });
});

describe("main.ts wiring: the household baseline comes from the configDir startServer is given", () => {
  it("a synthetic household.json in the configDir sets the forecast place and the baseline", async () => {
    const configDir = join(dir, "config") + "/";
    mkdirSync(configDir);
    writeFileSync(`${configDir}flags.json`, "{}");
    // Synthetic values only: a place and a baseline that differ from the committed example.
    writeFileSync(
      `${configDir}household.json`,
      JSON.stringify({
        airConditioning: true,
        heaterThisSeason: false,
        dryer: "none",
        location: { latitude: 40.42, longitude: -3.7 },
      }),
    );
    for (const name of ["models.json", "server.example.json"]) {
      copyFileSync(`${CONFIG_DIR}${name}`, `${configDir}${name}`);
    }
    const port = await freePort();
    running = await startServer(
      { SIB_DATA_DIR: join(dir, "data"), SIB_FAKE_MODEL: "1", SIB_PORT: String(port) },
      { configDir, output: () => undefined },
    );
    const { app, runtime } = running;
    const host = `localhost:${String(port)}`;
    const { token } = runtime.store.issuePairingToken();
    const cookie = cookieHeaderFrom(
      await app.inject({ method: "GET", url: `/pair?token=${token}`, headers: { host } }),
    );
    const quick = await app.inject({
      method: "POST",
      url: "/api/cards/quick",
      payload: { chore_type: "plants" },
      headers: { host, origin: `http://${host}`, cookie },
    });
    expect(quick.statusCode).toBe(201);

    const places = server.forecastRequests.map(
      (url) =>
        `${url.searchParams.get("latitude") ?? ""},${url.searchParams.get("longitude") ?? ""}`,
    );
    expect(places).toEqual(["40.42,-3.7"]);
  });

  it("a configDir with no household.json falls back to the household.example.json beside it", async () => {
    const configDir = join(dir, "config") + "/";
    mkdirSync(configDir);
    writeFileSync(`${configDir}flags.json`, "{}");
    writeFileSync(
      `${configDir}household.example.json`,
      JSON.stringify({
        airConditioning: false,
        heaterThisSeason: false,
        dryer: "heat-pump",
        location: { latitude: 48.86, longitude: 2.35 },
      }),
    );
    for (const name of ["models.json", "server.example.json"]) {
      copyFileSync(`${CONFIG_DIR}${name}`, `${configDir}${name}`);
    }
    const port = await freePort();
    running = await startServer(
      { SIB_DATA_DIR: join(dir, "data"), SIB_FAKE_MODEL: "1", SIB_PORT: String(port) },
      { configDir, output: () => undefined },
    );
    const host = `localhost:${String(port)}`;
    const { token } = running.runtime.store.issuePairingToken();
    const cookie = cookieHeaderFrom(
      await running.app.inject({ method: "GET", url: `/pair?token=${token}`, headers: { host } }),
    );
    await running.app.inject({
      method: "POST",
      url: "/api/cards/quick",
      payload: { chore_type: "plants" },
      headers: { host, origin: `http://${host}`, cookie },
    });
    expect(server.forecastRequests.map((url) => url.searchParams.get("latitude"))).toEqual([
      "48.86",
    ]);
  });
});

describe("main.ts wiring: with onboarding off, refetches ask for the current (default) location", () => {
  it("AC-029.2: a forecast refetched after the cache expires, for a photo, names the same place as the first", async () => {
    // Only the clock is faked, so the 1 h forecast cache can expire between the two requests.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const configDir = join(dir, "config") + "/";
    mkdirSync(configDir);
    writeFileSync(`${configDir}flags.json`, "{}");
    for (const name of ["models.json", "server.example.json", "household.example.json"]) {
      copyFileSync(`${CONFIG_DIR}${name}`, `${configDir}${name}`);
    }
    const port = await freePort();
    running = await startServer(
      { SIB_DATA_DIR: join(dir, "data"), SIB_FAKE_MODEL: "1", SIB_PORT: String(port) },
      { configDir, output: () => undefined },
    );
    const { app, runtime } = running;
    const host = `localhost:${String(port)}`;
    const origin = `http://${host}`;
    const { token } = runtime.store.issuePairingToken();
    const cookie = cookieHeaderFrom(
      await app.inject({ method: "GET", url: `/pair?token=${token}`, headers: { host } }),
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/cards/quick",
      payload: { chore_type: "plants" },
      headers: { host, origin, cookie },
    });
    expect(created.statusCode).toBe(201);
    const cardId = created.json<{ id: number }>().id;
    // A photo is refused (409) while Gemma is still setting the first odds, by design; under a
    // loaded full-suite run the first bookmaker job can still be running here.
    await vi.waitFor(() => {
      const row = runtime.db
        .prepare<[number], { gemma_state: string | null }>(
          "SELECT gemma_state FROM cards WHERE id = ?",
        )
        .get(cardId);
      expect(row?.gemma_state).not.toBe("thinking");
    });

    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    const multipart = multipartBody(await syntheticPhoto());
    const photo = await app.inject({
      method: "POST",
      url: `/api/cards/${String(cardId)}/photo`,
      payload: multipart.payload,
      headers: { host, origin, cookie, ...multipart.headers },
    });
    expect(photo.statusCode).toBe(201);
    await vi.waitFor(() => {
      expect(server.forecastRequests.length).toBeGreaterThanOrEqual(2);
    });

    const places = server.forecastRequests.map(
      (url) =>
        `${url.searchParams.get("latitude") ?? ""},${url.searchParams.get("longitude") ?? ""}`,
    );
    expect(new Set(places)).toEqual(new Set(["41.4,2.16"]));
  });
});

describe("main.ts wiring: the place search of onboarding (AC-024.4)", () => {
  async function start(extraEnv: Record<string, string>) {
    const configDir = join(dir, "config") + "/";
    mkdirSync(configDir);
    writeFileSync(`${configDir}flags.json`, JSON.stringify({ onboarding: true }));
    for (const name of ["models.json", "server.example.json", "household.example.json"]) {
      copyFileSync(`${CONFIG_DIR}${name}`, `${configDir}${name}`);
    }
    const port = await freePort();
    running = await startServer(
      {
        SIB_DATA_DIR: join(dir, "data"),
        SIB_FAKE_MODEL: "1",
        SIB_PORT: String(port),
        ...extraEnv,
      },
      { configDir, output: () => undefined },
    );
    const host = `localhost:${String(port)}`;
    const { token } = running.runtime.store.issuePairingToken();
    const cookie = cookieHeaderFrom(
      await running.app.inject({ method: "GET", url: `/pair?token=${token}`, headers: { host } }),
    );
    return (query: string) =>
      running!.app.inject({
        method: "GET",
        url: `/api/geocode?q=${encodeURIComponent(query)}`,
        headers: { host, cookie },
      });
  }

  it("with live weather the search goes to the geocoding host", async () => {
    const search = await start({});
    const response = await search("Gracia");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        { name: "Gràcia", admin1: "Barcelona", country: "Spain", latitude: 41.4, longitude: 2.16 },
      ],
    });
    expect(server.hostsSeen).toEqual(["geocoding-api.open-meteo.com"]);
  });

  it("with SIB_FAKE_WEATHER=1 the search answers from the synthetic places and calls nobody", async () => {
    const search = await start({ SIB_FAKE_WEATHER: "1" });
    const response = await search("madrid");
    expect(response.statusCode).toBe(200);
    expect(response.json<{ results: { name: string }[] }>().results.map((r) => r.name)).toEqual([
      "Madrid",
    ]);
    expect(server.requests).toHaveLength(0);
  });
});
