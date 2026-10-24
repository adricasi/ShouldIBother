import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { forgetDevices, printNetworkSummary, printNewPairingToken } from "./commands.js";
import { HouseholdStore } from "./household-store.js";
import { CONFIG_DIR, DEFAULT_LOCATION, loadHousehold } from "./config.js";
import { createCore, type Core } from "./core.js";
import { asDemoModel } from "./demo.js";
import { createFakeServices } from "./fakes.js";
import { loadModelsConfig } from "./model/config.js";
import { selectModel } from "./model/select.js";
import { loadFlags, type Flags } from "./flags.js";
import { listenLoopbackAndLan } from "./network.js";
import { PHOTOS_DIR, PhotoStore } from "./photos/store.js";
import { loadRules } from "./rules.js";
import { loadSavings } from "./savings.js";
import { loadRuntime, type Runtime } from "./runtime.js";
import type { WeatherClient } from "./weather/client.js";
import { OpenMeteoWeatherClient } from "./weather/open-meteo-client.js";
import { PLANNER_FORECAST_DAYS } from "./weather/open-meteo.js";
import { FakeGeocoder } from "./weather/fake-geocoder.js";
import { OpenMeteoGeocoder, createGeocodeHttp, type Geocoder } from "./weather/geocoding.js";

/**
 * Human-facing console output goes to stderr: stdout carries the JSON logs, so
 * `npm start > app.log` never writes a pairing URL into a log file.
 */
const print = (text: string): void => {
  console.error(text);
};

/** The built SPA (`npm run build`), relative to the repository for both `src/` and `dist/`. */
export const WEB_ROOT = fileURLToPath(new URL("../../dist/web/", import.meta.url));

/**
 * `sib demo` (AC-029.4): the server runs on a fixed clock with the flags of the `presentation`
 * preset applied in memory (nothing is written to `config/flags.json`), the fake model under the
 * demo model name and fake weather, whatever the environment says.
 */
export interface DemoStart {
  readonly now: () => number;
  readonly flags: Flags;
}

export interface StartOptions {
  /** Set by `sib demo` only. */
  readonly demo?: DemoStart;
  /** Where the summary, pairing banner and pairing lines go; stderr by default. */
  readonly output?: (text: string) => void;
  /**
   * Directory with `server.json`, `flags.json`, `models.json` and `household.json`; the
   * repository's `config/` by default.
   */
  readonly configDir?: string;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly runtime: Runtime;
  /** Stops listening and closes the database. */
  close(): Promise<void>;
}

/**
 * Starts the server on 127.0.0.1 and the LAN address only (NFR-001), prints the Host allowlist
 * and a fresh pairing token. The caller decides when to close it (the CLI does so on SIGINT).
 */
export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  options: StartOptions = {},
): Promise<RunningServer> {
  const output = options.output ?? print;
  const configDir = options.configDir ?? CONFIG_DIR;
  const runtime = loadRuntime(env, configDir);
  let app: FastifyInstance;
  let appRef: FastifyInstance | undefined;
  let core: Core;
  let modelNotice: string;
  const webBuilt = existsSync(`${WEB_ROOT}index.html`);
  try {
    const demo = options.demo;
    const flags = demo?.flags ?? loadFlags(`${configDir}flags.json`);
    const now = demo?.now ?? Date.now;
    const fakes = createFakeServices(now);
    const household = loadHousehold(configDir);
    // Onboarding answers (flag `onboarding`) replace the baseline, location included.
    const householdStore = flags.onboarding
      ? new HouseholdStore(runtime.db, household, now, (entry) => appRef?.log.warn(entry))
      : undefined;
    const modelsConfig = loadModelsConfig(`${configDir}models.json`);
    const selection = await selectModel(modelsConfig, {
      useFake: demo !== undefined || env["SIB_FAKE_MODEL"] === "1",
      fake: () => (demo === undefined ? fakes.model : asDemoModel(fakes.model)),
      voice: flags.voice,
      env,
      finetunedBookmaker: flags.finetunedBookmaker,
    });
    modelNotice = selection.notice;
    const useFakeWeather = demo !== undefined || env["SIB_FAKE_WEATHER"] === "1";
    const weather: WeatherClient = useFakeWeather
      ? fakes.weather
      : new OpenMeteoWeatherClient({
          db: runtime.db,
          now,
          location: () => (householdStore?.current() ?? household).location ?? DEFAULT_LOCATION,
          log: (entry) => appRef?.log.info(entry),
          requestSunset: flags.laundryTonight,
          // The planner scores four days (REQ-021); with it off the request is what it was.
          ...(flags.laundryPlanner ? { forecastDays: PLANNER_FORECAST_DAYS } : {}),
        });
    // The onboarding place search (AC-024.4): synthetic places with fake weather, so the demo and
    // the e2e run need no network; otherwise Open-Meteo geocoding, counted like every other call.
    const geocoder: Geocoder = useFakeWeather
      ? new FakeGeocoder()
      : new OpenMeteoGeocoder(
          createGeocodeHttp(runtime.db, now, { log: (entry) => appRef?.log.info(entry) }),
        );
    core = createCore({
      db: runtime.db,
      now,
      weather,
      geocoder,
      model: selection.model,
      rules: loadRules(),
      household,
      ...(householdStore === undefined ? {} : { householdStore }),
      savings: loadSavings(),
      flags,
      ...(demo === undefined ? {} : { demo: true }),
      photos: new PhotoStore(join(runtime.dataDir, PHOTOS_DIR)),
      runner: {
        toolUse: modelsConfig.gemma.toolUse,
        answerMode: modelsConfig.gemma.answerMode,
        jobModels: selection.jobModels,
      },
      onSchedulerError: (error) => {
        console.error("Scheduler pass failed", error);
      },
      onBackgroundError: (error) => {
        console.error("A Gemma step failed unexpectedly", error);
      },
    });
    if (selection.warmUp !== undefined) {
      // Warm-up call at start: the model loads while the person scans the QR code.
      void selection.warmUp().then((health) => {
        output(
          `Gemma warm-up: ${health.state}${health.detail === undefined ? "" : ` (${health.detail})`}`,
        );
      });
    }
    if (demo !== undefined) {
      // The weather board and "forecast age" read the newest forecast without a call of their own.
      await fakes.weather.getForecast({ fromMs: now(), hours: 48, pastHours: 24 });
    }
    app = await buildApp({
      flags,
      logger: true,
      core,
      ...(webBuilt ? { webRoot: WEB_ROOT } : {}),
      auth: { store: runtime.store, allowlist: runtime.allowlist, print: output },
    });
    appRef = app;
    app.addHook("onClose", async () => {
      // A clean stop: no new scheduler ticks, and running Gemma jobs finish before the database
      // closes (otherwise a late job step writes to a closed connection).
      core.scheduler.stop();
      await core.gemma.idle();
      runtime.db.close();
    });
    await listenLoopbackAndLan(app, { port: runtime.port, lanAddress: runtime.lanAddress });
  } catch (error) {
    runtime.db.close();
    throw error;
  }
  core.scheduler.start();
  output(modelNotice);
  output(
    options.demo !== undefined || env["SIB_FAKE_WEATHER"] === "1"
      ? "The weather is fake (SIB_FAKE_WEATHER=1)."
      : "The weather is Open-Meteo.",
  );
  if (!webBuilt) {
    output("The app screens are not built: run `npm run build` first (the API is up).");
  }
  printNetworkSummary(runtime, output);
  printNewPairingToken({ ...runtime, publicOrigins: runtime.config.publicOrigins }, output);
  return { app, runtime, close: () => app.close() };
}

/** `sib pair`: a new token without signing anyone out. */
export function pairCommand(runtime: Runtime, output: (text: string) => void = print): void {
  try {
    printNewPairingToken({ ...runtime, publicOrigins: runtime.config.publicOrigins }, output);
  } finally {
    runtime.db.close();
  }
}

/** `sib forget-devices`. */
export function forgetDevicesCommand(
  runtime: Runtime,
  output: (text: string) => void = print,
): void {
  try {
    forgetDevices(runtime.store, output);
  } finally {
    runtime.db.close();
  }
}
