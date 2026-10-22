import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { forgetDevices, printNetworkSummary, printNewPairingToken } from "./commands.js";
import { CONFIG_DIR } from "./config.js";
import { createCore, type Core } from "./core.js";
import { createFakeServices } from "./fakes.js";
import { loadFlags } from "./flags.js";
import { listenLoopbackAndLan } from "./network.js";
import { loadRules } from "./rules.js";
import { loadRuntime, type Runtime } from "./runtime.js";

/**
 * Human-facing console output goes to stderr: stdout carries the JSON logs, so
 * `npm start > app.log` never writes a pairing URL into a log file.
 */
const print = (text: string): void => {
  console.error(text);
};

/** The built SPA (`npm run build`), relative to the repository for both `src/` and `dist/`. */
export const WEB_ROOT = fileURLToPath(new URL("../../dist/web/", import.meta.url));

export interface StartOptions {
  /** Where the summary, pairing banner and pairing lines go; stderr by default. */
  readonly output?: (text: string) => void;
  /** Directory with `server.json` and `flags.json`; the repository's `config/` by default. */
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
  let core: Core;
  const webBuilt = existsSync(`${WEB_ROOT}index.html`);
  try {
    const flags = loadFlags(`${configDir}flags.json`);
    const now = Date.now;
    const { model, weather } = createFakeServices(now);
    core = createCore({
      db: runtime.db,
      now,
      weather,
      model,
      rules: loadRules(),
      flags,
      onSchedulerError: (error) => {
        console.error("Scheduler pass failed", error);
      },
    });
    app = await buildApp({
      flags,
      logger: true,
      core,
      ...(webBuilt ? { webRoot: WEB_ROOT } : {}),
      auth: { store: runtime.store, allowlist: runtime.allowlist, print: output },
    });
    app.addHook("onClose", () => {
      runtime.db.close();
    });
    await listenLoopbackAndLan(app, { port: runtime.port, lanAddress: runtime.lanAddress });
  } catch (error) {
    runtime.db.close();
    throw error;
  }
  core.scheduler.start();
  output(
    "Odds and verdicts come from the fake model and fake weather until the real clients land.",
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
