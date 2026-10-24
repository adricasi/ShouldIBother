import { mkdtempSync, rmSync } from "node:fs";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InjectOptions, LightMyRequestResponse } from "fastify";

import { buildApp } from "../src/server/app.js";
import { type Household } from "../src/server/config.js";
import { buildAllowlist } from "../src/server/auth/allowlist.js";
import { AuthStore } from "../src/server/auth/store.js";
import { createCore, type Core } from "../src/server/core.js";
import { judgeScenarioFromAnswer } from "../src/server/fakes.js";
import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { parseFlags, type FlagName } from "../src/server/flags.js";
import { PhotoStore } from "../src/server/photos/store.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { FakeModelClient } from "../src/server/model/fake.js";
import { loadRules } from "../src/server/rules.js";
import { loadSavings } from "../src/server/savings.js";
import type { WeatherClient } from "../src/server/weather/client.js";
import type { Geocoder } from "../src/server/weather/geocoding.js";
import { FakeWeatherClient, type FakeWeatherProfile } from "../src/server/weather/fake.js";

import { multipartBody } from "./support/photos.js";
import {
  FAKE_INTERFACES,
  FakeClock,
  LOCAL_HOST,
  LOCAL_ORIGIN,
  PORT,
  cookieHeaderFrom,
} from "./helpers.js";

/** The committed example baseline, spelled out so a real `household.json` never changes a test. */
export const EXAMPLE_HOUSEHOLD: Household = {
  airConditioning: false,
  heaterThisSeason: false,
  dryer: "heat-pump",
};

export interface CoreHarnessOptions {
  /** A database file; omitted: in-memory. Pass the same path to simulate a restart. */
  dbPath?: string;
  clock?: FakeClock;
  flags?: Partial<Record<FlagName, boolean>>;
  weatherProfile?: FakeWeatherProfile;
  webRoot?: string;
  model?: FakeModelClient;
  /** Folder for the photo files; a fresh temporary folder (removed on close) when omitted. */
  photosDir?: string;
  /** Timeouts and tool settings of the job runner. */
  runner?: NonNullable<Parameters<typeof createCore>[0]["runner"]>;
  /** The household baseline; the committed example (no AC, no heater) when omitted. */
  household?: Household;
  /** A weather client to use instead of the fake one (the Open-Meteo client on a fake HTTP server). */
  liveWeather?: (db: Db, now: () => number) => WeatherClient;
  /** The place search of onboarding; omitted: the search answers "offline". */
  geocoder?: Geocoder;
  /** Collects the structured log lines (one JSON line each) of the app, for tests of log events. */
  logLines?: string[];
}

export interface CoreHarness {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly db: Db;
  readonly clock: FakeClock;
  readonly store: AuthStore;
  readonly core: Core;
  readonly photos: PhotoStore;
  readonly model: FakeModelClient;
  readonly weather: FakeWeatherClient;
  /** Waits until no Gemma job is queued or running. */
  idle(): Promise<void>;
  /** Session cookie of a paired device; sessions live in the database, so it survives a restart. */
  cookie: string;
  request(options: InjectOptions & { url: string }): Promise<LightMyRequestResponse>;
  /** GET with the session. */
  get(url: string): Promise<LightMyRequestResponse>;
  /** POST JSON with the session and a same-origin Origin header. */
  post(url: string, body: unknown): Promise<LightMyRequestResponse>;
  /** DELETE with the session and a same-origin Origin header. */
  delete(url: string): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/** The app with the core loop on the fake model and fake weather, paired like a phone would be. */
export async function createCoreHarness(options: CoreHarnessOptions = {}): Promise<CoreHarness> {
  const clock = options.clock ?? new FakeClock();
  const db = openDatabase(options.dbPath ?? ":memory:");
  migrate(db, MIGRATIONS);
  const store = new AuthStore(db, clock.now);
  const ownPhotosDir =
    options.photosDir === undefined ? mkdtempSync(join(tmpdir(), "sib-photos-")) : undefined;
  const photos = new PhotoStore(options.photosDir ?? ownPhotosDir!);
  const model = options.model ?? new FakeModelClient({ scenario: judgeScenarioFromAnswer });
  if (options.model === undefined) {
    // The bookmaker is offline unless a test brings it online: the cards of the older tests keep
    // their rule odds, and no Gemma quote arrives between two of their calls.
    model.setScenario("bookmaker", "offline");
  }
  const weather = new FakeWeatherClient(clock.now, options.weatherProfile);
  const flags = parseFlags(options.flags ?? {});
  const core = createCore({
    db,
    now: clock.now,
    weather: options.liveWeather?.(db, clock.now) ?? weather,
    model,
    rules: loadRules(),
    household: options.household ?? EXAMPLE_HOUSEHOLD,
    savings: loadSavings(),
    flags,
    photos,
    ...(options.geocoder === undefined ? {} : { geocoder: options.geocoder }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  const app = await buildApp({
    flags,
    core,
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    ...(options.logLines === undefined
      ? {}
      : {
          logger: true,
          logStream: new Writable({
            write(chunk: Buffer, _encoding, done) {
              options.logLines?.push(chunk.toString());
              done();
            },
          }),
        }),
    auth: {
      store,
      allowlist: buildAllowlist({
        port: PORT,
        interfaces: FAKE_INTERFACES,
        allowedHosts: [],
        publicOrigins: [],
      }),
      print: () => undefined,
    },
  });

  const harness: CoreHarness = {
    app,
    db,
    clock,
    store,
    core,
    photos,
    model,
    weather,
    cookie: "",
    idle: () => core.idle(),
    request: (request) =>
      app.inject({ ...request, headers: { host: LOCAL_HOST, ...request.headers } }),
    get: (url) => harness.request({ method: "GET", url, headers: { cookie: harness.cookie } }),
    post: (url, body) =>
      harness.request({
        method: "POST",
        url,
        payload: body as Record<string, unknown>,
        headers: { cookie: harness.cookie, origin: LOCAL_ORIGIN },
      }),
    delete: (url) =>
      harness.request({
        method: "DELETE",
        url,
        headers: { cookie: harness.cookie, origin: LOCAL_ORIGIN },
      }),
    close: async () => {
      await app.close();
      db.close();
      if (ownPhotosDir !== undefined) {
        rmSync(ownPhotosDir, { recursive: true, force: true });
      }
    },
  };
  return harness;
}

/** Pairs a device on a fresh token and stores its cookie on the harness. */
export async function pair(harness: CoreHarness): Promise<void> {
  const { token } = harness.store.issuePairingToken();
  harness.cookie = cookieHeaderFrom(
    await harness.request({ method: "GET", url: `/pair?token=${token}` }),
  );
}

/** POSTs a photo to a card the way the app does (multipart, session cookie, same-origin Origin). */
export async function uploadPhoto(
  harness: CoreHarness,
  cardId: number,
  bytes: Buffer,
  options: { fileName?: string; contentType?: string } = {},
): Promise<LightMyRequestResponse> {
  const body = multipartBody(bytes, options);
  return await harness.request({
    method: "POST",
    url: `/api/cards/${cardId}/photo`,
    payload: body.payload,
    headers: { cookie: harness.cookie, origin: LOCAL_ORIGIN, ...body.headers },
  });
}
