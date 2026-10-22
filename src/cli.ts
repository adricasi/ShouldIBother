#!/usr/bin/env node
import { startServer } from "./server/main.js";

const USAGE = "Usage: sib start";

async function main(args: readonly string[]): Promise<number> {
  const [command] = args;
  if (command === "start") {
    await startServer();
    return 0;
  }
  console.error(command === undefined ? USAGE : `Unknown command: ${command}\n${USAGE}`);
  return 1;
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
