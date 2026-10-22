import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { forgetDevices, printNetworkSummary, printNewPairingToken } from "./commands.js";
import { CONFIG_DIR } from "./config.js";
import { loadFlags } from "./flags.js";
import { listenLoopbackAndLan } from "./network.js";
import { loadRuntime, type Runtime } from "./runtime.js";

/**
 * Human-facing console output goes to stderr: stdout carries the JSON logs, so
 * `npm start > app.log` never writes a pairing URL into a log file.
 */
const print = (text: string): void => {
  console.error(text);
};

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
  try {
    app = await buildApp({
      flags: loadFlags(`${configDir}flags.json`),
      logger: true,
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
