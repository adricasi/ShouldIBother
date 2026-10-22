import { buildApp } from "./app.js";
import { forgetDevices, printNetworkSummary, printNewPairingToken } from "./commands.js";
import { loadFlags } from "./flags.js";
import { listenLoopbackAndLan } from "./network.js";
import { loadRuntime, type Runtime } from "./runtime.js";

const print = (text: string): void => {
  console.log(text);
};

/**
 * Starts the server on 127.0.0.1 and the LAN address only (NFR-001), prints the Host allowlist
 * and a fresh pairing token, and closes cleanly on SIGINT/SIGTERM.
 */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = loadRuntime(env);
  const app = await buildApp({
    flags: loadFlags(),
    logger: true,
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
