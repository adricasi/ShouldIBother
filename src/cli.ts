#!/usr/bin/env node
import { forgetDevicesCommand, pairCommand, startServer } from "./server/main.js";
import { loadRuntime } from "./server/runtime.js";

const USAGE = "Usage: sib start | pair | forget-devices";

async function main(args: readonly string[]): Promise<number> {
  const [command] = args;
  switch (command) {
    case "start":
      await startServer();
      return 0;
    case "pair":
      pairCommand(loadRuntime());
      return 0;
    case "forget-devices":
      forgetDevicesCommand(loadRuntime());
      return 0;
    default:
      console.error(command === undefined ? USAGE : `Unknown command: ${command}\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
