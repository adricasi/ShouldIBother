import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "./db.js";
import type { ChatRequest, ChatResponse, ModelClient, ModelHealth } from "./model/client.js";

/**
 * Sample-data demo (AC-029.4): what the server and the data commands need to know about it. The
 * seeding itself lives in `src/demo/`.
 */

/**
 * The model name every demo decision carries, so a bet's `model_version` reads `fake-demo`. Score
 * counts such rows only in demo mode (NFR-010); outside it a name starting `fake` never counts.
 */
export const DEMO_MODEL = "fake-demo";

/** A file the demo writes in its temporary data folder; `sib export` refuses a folder that has it. */
export const DEMO_MARKER_FILE = "DEMO-SAMPLE-DATA";

const MARKER_TEXT =
  "Sample data made by `sib demo`: synthetic bets, a fake model and fake weather. Not results.\n";

export function markDemoDataDir(dataDir: string): void {
  writeFileSync(join(dataDir, DEMO_MARKER_FILE), MARKER_TEXT, { mode: 0o600 });
}

export function isDemoDataDir(dataDir: string): boolean {
  return existsSync(join(dataDir, DEMO_MARKER_FILE));
}

/**
 * True when the database holds rows written by the demo model, whatever the marker file says: a
 * deleted marker must not let sample data be exported as results.
 */
export function holdsDemoRows(db: Pick<Db, "prepare">): boolean {
  const row = db
    .prepare<[string, string], { found: number }>(
      `SELECT EXISTS (SELECT 1 FROM bets WHERE model_version LIKE ?)
           OR EXISTS (SELECT 1 FROM gemma_decisions WHERE model LIKE ?) AS found`,
    )
    .get(`${DEMO_MODEL}%`, `${DEMO_MODEL}%`);
  return row?.found === 1;
}

/** The words of the refusal when something that reports results is asked of sample data. */
export const DEMO_EXPORT_REFUSAL =
  "This data folder holds sample data from `sib demo` (synthetic bets, fake model, fake weather). It is never exported, so it cannot pass for results. Nothing was written.";

/** The same model client, answering under the demo model name. */
export function asDemoModel(inner: ModelClient): ModelClient {
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const response = await inner.chat(request);
      return { content: response.content, toolCalls: response.toolCalls, model: DEMO_MODEL };
    },
    health(): Promise<ModelHealth> {
      return inner.health();
    },
  };
}
