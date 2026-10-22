import type { InjectOptions, LightMyRequestResponse } from "fastify";

import { buildApp } from "../src/server/app.js";
import { type Household } from "../src/server/config.js";
import { buildAllowlist } from "../src/server/auth/allowlist.js";
import { AuthStore } from "../src/server/auth/store.js";
import { createCore, type Core } from "../src/server/core.js";
import { judgeScenarioFromAnswer } from "../src/server/fakes.js";
import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { parseFlags, type FlagName } from "../src/server/flags.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { FakeModelClient } from "../src/server/model/fake.js";
import { loadRules } from "../src/server/rules.js";
import { FakeWeatherClient, type FakeWeatherProfile } from "../src/server/weather/fake.js";

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
  /** The household baseline; the committed example (no AC, no heater) when omitted. */
  household?: Household;
}

export interface CoreHarness {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly db: Db;
  readonly clock: FakeClock;
  readonly store: AuthStore;
  readonly core: Core;
  readonly model: FakeModelClient;
  readonly weather: FakeWeatherClient;
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
  const model = options.model ?? new FakeModelClient({ scenario: judgeScenarioFromAnswer });
  const weather = new FakeWeatherClient(clock.now, options.weatherProfile);
  const flags = parseFlags(options.flags ?? {});
  const core = createCore({
    db,
    now: clock.now,
    weather,
    model,
    rules: loadRules(),
    household: options.household ?? EXAMPLE_HOUSEHOLD,
    flags,
  });
  const app = await buildApp({
    flags,
    core,
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
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
    model,
    weather,
    cookie: "",
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
