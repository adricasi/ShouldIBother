import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { createCore } from "./core.js";
import { createFakeServices } from "./fakes.js";
import { forgetDevices, printNetworkSummary, printNewPairingToken } from "./commands.js";
import { loadFlags } from "./flags.js";
import { listenLoopbackAndLan } from "./network.js";
import { loadRules } from "./rules.js";
import { loadRuntime, type Runtime } from "./runtime.js";

const print = (text: string): void => {
  console.log(text);
};

/** The built SPA (`npm run build`), relative to the repository for both `src/` and `dist/`. */
export const WEB_ROOT = fileURLToPath(new URL("../../dist/web/", import.meta.url));

/**
 * Starts the server on 127.0.0.1 and the LAN address only (NFR-001), prints the Host allowlist
 * and a fresh pairing token, and closes cleanly on SIGINT/SIGTERM.
 */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = loadRuntime(env);
  const flags = loadFlags();
  const now = Date.now;
  const { model, weather } = createFakeServices(now);
  const core = createCore({
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
  const webBuilt = existsSync(`${WEB_ROOT}index.html`);
  const app = await buildApp({
    flags,
    logger: true,
    core,
    ...(webBuilt ? { webRoot: WEB_ROOT } : {}),
    auth: { store: runtime.store, allowlist: runtime.allowlist, print },
  });
  app.addHook("onClose", () => {
    runtime.db.close();
  });
  await listenLoopbackAndLan(app, { port: runtime.port, lanAddress: runtime.lanAddress });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close();
    });
  }
  core.scheduler.start();
  print("Odds and verdicts come from the fake model and fake weather until the real clients land.");
  if (!webBuilt) {
    print("The app screens are not built: run `npm run build` first (the API is up).");
  }
  printNetworkSummary(runtime, print);
  printNewPairingToken({ ...runtime, publicOrigins: runtime.config.publicOrigins }, print);
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
