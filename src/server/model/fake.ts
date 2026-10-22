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

const toolCallsSchema = z.array(
  z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
);

const stepSchema = z
  .object({
    model: z.string().default("fake-gemma"),
    toolCalls: toolCallsSchema.default([]),
    /** The answer: an object is sent as JSON, a string as written (for invalid-JSON fixtures). */
    content: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    /** A runtime failure instead of an answer. */
    error: z.enum(["timeout", "unavailable"]).optional(),
  })
  .strict();

type Step = z.infer<typeof stepSchema>;

/**
 * A fixture is one response (the step fields at the top level) or a script of `steps`, one per
 * call of the job, so a tool call followed by an answer, or an invalid answer followed by a valid
 * retry, can be replayed. A script that runs out is an error: the job made more calls than
 * recorded.
 */
const fixtureSchema = z
  .object({
    description: z.string(),
    steps: z.array(stepSchema).min(1).optional(),
    model: z.string().optional(),
    toolCalls: toolCallsSchema.optional(),
    content: stepSchema.shape.content,
    error: stepSchema.shape.error,
  })
  .strict()
  .refine(
    (fixture) =>
      fixture.steps === undefined ||
      (fixture.model === undefined &&
        fixture.toolCalls === undefined &&
        fixture.content === undefined &&
        fixture.error === undefined),
    "A fixture has either steps or a single response, not both",
  );

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
  /** Calls consumed so far per `job/scenario`, for scripted fixtures. */
  private readonly consumed = new Map<string, number>();

  constructor(options: FakeModelOptions = {}) {
    this.fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
    this.defaultScenario = options.scenario ?? (() => "ok");
  }

  /** Makes every later call of `job` use `scenario` until changed. */
  setScenario(job: string, scenario: string): void {
    this.overrides.set(job, scenario);
    this.consumed.delete(`${job}/${scenario}`);
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
    const key = `${request.job}/${scenario}`;
    const index = this.consumed.get(key) ?? 0;
    this.consumed.set(key, index + 1);
    let step: Step;
    if (fixture.steps === undefined) {
      step = stepSchema.parse({
        ...(fixture.model === undefined ? {} : { model: fixture.model }),
        ...(fixture.toolCalls === undefined ? {} : { toolCalls: fixture.toolCalls }),
        ...(fixture.content === undefined ? {} : { content: fixture.content }),
        ...(fixture.error === undefined ? {} : { error: fixture.error }),
      });
    } else {
      const scripted = fixture.steps[index];
      if (scripted === undefined) {
        throw new Error(
          `Fixture ${key} has ${fixture.steps.length} steps; call ${index + 1} has none`,
        );
      }
      step = scripted;
    }
    if (step.error === "timeout") {
      throw new ModelTimeoutError(`Fixture ${key}: timeout`);
    }
    if (step.error === "unavailable") {
      throw new ModelUnavailableError(`Fixture ${key}: unavailable`);
    }
    const content =
      typeof step.content === "string" ? step.content : JSON.stringify(step.content ?? {});
    return { content, toolCalls: step.toolCalls, model: step.model };
  }
}
