import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  ModelTimeoutError,
  ModelUnavailableError,
  type ChatRequest,
  type ChatResponse,
  type ModelClient,
} from "./client.js";

/** Where the synthetic fixtures live: `<job>/<scenario>.json` (design.md, Testing strategy). */
export const FIXTURES_DIR = fileURLToPath(
  new URL("../../../test/fixtures/gemma/", import.meta.url),
);

const NAME = /^[a-z0-9][a-z0-9-]*$/;

const fixtureSchema = z
  .object({
    description: z.string(),
    model: z.string().default("fake-gemma"),
    toolCalls: z
      .array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }))
      .default([]),
    /** The answer: an object is sent as JSON, a string as written (for invalid-JSON fixtures). */
    content: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    /** A runtime failure instead of an answer. */
    error: z.enum(["timeout", "unavailable"]).optional(),
  })
  .strict();

export type ScenarioSelector = (request: ChatRequest) => string;

export interface FakeModelOptions {
  readonly fixturesDir?: string;
  /** Picks the scenario for a call that has no override; defaults to `ok`. */
  readonly scenario?: ScenarioSelector;
}

/**
 * Returns recorded or hand-written answers from `<fixturesDir>/<job>/<scenario>.json`. Fixtures
 * are keyed by job and scenario name, never by the input, so a prompt change does not invalidate
 * them. No GPU, model or network (NFR-010).
 */
export class FakeModelClient implements ModelClient {
  readonly calls: ChatRequest[] = [];
  private readonly fixturesDir: string;
  private readonly defaultScenario: ScenarioSelector;
  private readonly overrides = new Map<string, string>();

  constructor(options: FakeModelOptions = {}) {
    this.fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
    this.defaultScenario = options.scenario ?? (() => "ok");
  }

  /** Makes every later call of `job` use `scenario` until changed. */
  setScenario(job: string, scenario: string): void {
    this.overrides.set(job, scenario);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    const scenario = this.overrides.get(request.job) ?? this.defaultScenario(request);
    if (!NAME.test(request.job) || !NAME.test(scenario)) {
      throw new Error(`Invalid fixture name ${request.job}/${scenario}`);
    }
    const path = join(this.fixturesDir, request.job, `${scenario}.json`);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      throw new Error(`No fixture for job ${request.job}, scenario ${scenario} (${path})`, {
        cause: error,
      });
    }
    const fixture = fixtureSchema.parse(JSON.parse(text));
    if (fixture.error === "timeout") {
      throw new ModelTimeoutError(`Fixture ${request.job}/${scenario}: timeout`);
    }
    if (fixture.error === "unavailable") {
      throw new ModelUnavailableError(`Fixture ${request.job}/${scenario}: unavailable`);
    }
    const content =
      typeof fixture.content === "string" ? fixture.content : JSON.stringify(fixture.content ?? {});
    return { content, toolCalls: fixture.toolCalls, model: fixture.model };
  }
}
