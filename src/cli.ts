#!/usr/bin/env node
import { createInterface } from "node:readline/promises";

import { demoCommand } from "./demo/command.js";
import { datasetCommand } from "./backtest/dataset-command.js";
import { backtestCommand } from "./backtest/harness/command.js";
import { snapshotCommand } from "./backtest/snapshot-command.js";
import { evalCommand } from "./eval/command.js";
import { flagsCommand } from "./server/flags-command.js";
import { hostedCheckCommand } from "./server/model/hosted-check.js";
import { deletePhotosCommand, exportCommand, type Confirm } from "./server/data-commands.js";
import { forgetDevicesCommand, pairCommand, startServer } from "./server/main.js";
import { loadRuntime } from "./server/runtime.js";

const USAGE =
  "Usage: sib start | pair | forget-devices | delete-photos [--all-data] | export <dir> | snapshot | dataset | backtest [options] | eval <job> [options] | flags [list|on|off|preset] | demo [--port N] | hosted-check";

/** Asks on the console and accepts only the exact word (AC-015.3). */
const confirm: Confirm = async (question, expected) => {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await lines.question(question)).trim() === expected;
  } catch {
    // No answer (stdin closed): cancel.
    return false;
  } finally {
    lines.close();
  }
};

const print = (text: string): void => {
  console.error(text);
};

async function main(args: readonly string[]): Promise<number> {
  const [command] = args;
  switch (command) {
    case "start": {
      const server = await startServer();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          server.close().catch((error: unknown) => {
            console.error("Shutdown failed:", error);
            process.exitCode = 1;
          });
        });
      }
      return 0;
    }
    case "pair":
      pairCommand(loadRuntime());
      return 0;
    case "forget-devices":
      forgetDevicesCommand(loadRuntime());
      return 0;
    case "delete-photos": {
      const flags = args.slice(1);
      const unknown = flags.filter((flag) => flag !== "--all-data");
      if (unknown.length > 0) {
        console.error(`Unknown option: ${unknown.join(" ")}\n${USAGE}`);
        return 1;
      }
      await deletePhotosCommand(
        loadRuntime(),
        { allData: flags.includes("--all-data") },
        { confirm, print },
      );
      return 0;
    }
    case "export": {
      const [directory, ...extra] = args.slice(1);
      if (directory === undefined || extra.length > 0) {
        console.error(USAGE);
        return 1;
      }
      exportCommand(loadRuntime(), directory, print);
      return 0;
    }
    case "snapshot":
      return await snapshotCommand(args.slice(1), print);
    case "dataset":
      return await datasetCommand(args.slice(1), print);
    case "backtest":
      return await backtestCommand(args.slice(1), print);
    case "demo":
      return await demoCommand(args.slice(1), print);
    case "flags":
      return flagsCommand(args.slice(1), print);
    case "hosted-check":
      return await hostedCheckCommand(process.env, print);
    case "eval":
      return await evalCommand(args.slice(1), print);
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
