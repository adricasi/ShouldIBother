import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { CHORES } from "../src/domain/chores.js";
import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { judgeBet } from "../src/server/gemma/judge.js";
import {
  JobRunner,
  JobQueueFullError,
  JobToolArgumentError,
  JobToolError,
  MAX_MODEL_CALLS,
  MAX_QUEUED_JOBS,
  type JobRequest,
  type JobTool,
  type RunnerOptions,
} from "../src/server/gemma/runner.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import {
  ModelUnavailableError,
  type ChatRequest,
  type ChatResponse,
  type ModelClient,
} from "../src/server/model/client.js";

import { FakeClock } from "./helpers.js";

const answerSchema = z.object({ answer: z.enum(["yes", "no"]) }).strict();
const prompt = { version: "test.v1", text: "You are a test job." };
const GOOD = JSON.stringify({ answer: "yes" });

type Handler = (request: ChatRequest, callNumber: number) => Promise<ChatResponse> | ChatResponse;

/** A model whose answers come from a function, so a test scripts any sequence of calls. */
class ScriptedModel implements ModelClient {
  readonly calls: ChatRequest[] = [];
  constructor(private readonly handler: Handler) {}
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    return this.handler(request, this.calls.length);
  }
  health(): Promise<{ state: "online" }> {
    return Promise.resolve({ state: "online" });
  }
}

const answer = (content: string, extra: Partial<ChatResponse> = {}): ChatResponse => ({
  content,
  toolCalls: [],
  model: "test-model",
  ...extra,
});
const callTool = (args: Record<string, unknown> = { hours_ahead: 12 }): ChatResponse =>
  answer("", { toolCalls: [{ name: "get_forecast", arguments: args }] });

function tool(required: boolean, executed: unknown[] = []): JobTool {
  return {
    definition: {
      name: "get_forecast",
      description: "test tool",
      parameters: { type: "object", properties: {} },
    },
    required,
    injectedArguments: { hours_ahead: 24 },
    execute: (args) => {
      executed.push(args);
      return Promise.resolve("<untrusted_data>forecast</untrusted_data>");
    },
  };
}

const request = (overrides: Partial<JobRequest<{ answer: "yes" | "no" }>> = {}) => ({
  job: "test",
  prompt,
  user: "<untrusted_data>private household text</untrusted_data>",
  schema: answerSchema,
  inputSummary: "a test input",
  ...overrides,
});

/** Lets the first queued job reach the model before the test moves the clock. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let db: Db;
afterEach(() => {
  db.close();
});

function setup(handler: Handler, options: Partial<RunnerOptions> = {}) {
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS);
  const clock = new FakeClock();
  const model = new ScriptedModel(handler);
  const runner = new JobRunner({ model, db, now: clock.now, ...options });
  return { model, runner, clock };
}

const decisions = () =>
  db.prepare<[], Record<string, unknown>>("SELECT * FROM gemma_decisions ORDER BY id").all();

describe("Gemma job runner: validation, retry and the decision log (REQ-028)", () => {
  it("AC-028.2: stores job, model, digest, prompt version, latency and the raw validated output", async () => {
    const { runner } = setup(() => answer(GOOD, { modelDigest: "sha256:abc" }));
    const result = await runner.run(request());
    expect(result).toMatchObject({ ok: true, output: { answer: "yes" }, retries: 0, calls: 1 });
    expect(decisions()).toEqual([
      expect.objectContaining({
        job: "test",
        model: "test-model",
        model_digest: "sha256:abc",
        prompt_version: "test.v1",
        tool_mode: null,
        input_summary: "a test input",
        output: GOOD,
        valid: 1,
        retries: 0,
        error: null,
      }),
    ]);
    expect(Number(decisions()[0]?.["latency_ms"])).toBeGreaterThanOrEqual(0);
  });

  it("links the decision to the card, bet and photo it was about", async () => {
    const { runner } = setup(() => answer(GOOD));
    db.exec(`INSERT INTO cards (id, input_text, chore_type, kind, created_at) VALUES (1, 'c', 'plants', 'weather', 1);
      INSERT INTO bets (id, card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at)
        VALUES (1, 1, 'do_nothing', 2, 50, 'rule', 'r', 2, 1, 2, 3);
      INSERT INTO photos (id, card_id, role, file, received_at, width, height) VALUES ('p1', 1, 'before', 'f', 1, 1, 1);`);
    await runner.run(request({ cardId: 1, betId: 1, photoId: "p1" }));
    expect(decisions()[0]).toMatchObject({ card_id: 1, bet_id: 1, photo_id: "p1" });
  });

  it("retries once with the validation error and records the retry", async () => {
    const { runner, model } = setup((_request, n) => answer(n === 1 ? '{"answer":"maybe"}' : GOOD));
    const result = await runner.run(request());
    expect(result).toMatchObject({ ok: true, retries: 1, calls: 2 });
    const retryMessages = model.calls[1]?.messages ?? [];
    expect(retryMessages.at(-1)?.role).toBe("user");
    expect(retryMessages.at(-1)?.content).toContain("rejected");
    expect(retryMessages.at(-1)?.content).toContain("answer");
    expect(decisions()[0]).toMatchObject({ valid: 1, retries: 1 });
    expect(String(decisions()[0]?.["error"])).toContain("retry after");
  });

  it("fails after the retry, keeps the last raw answer and logs the failure", async () => {
    const { runner } = setup(() => answer("not json"));
    const result = await runner.run(request());
    expect(result).toMatchObject({
      ok: false,
      failure: "invalid",
      raw: "not json",
      retries: 1,
      calls: 2,
    });
    expect(decisions()[0]).toMatchObject({ valid: 0, retries: 1, output: "not json" });
    expect(String(decisions()[0]?.["error"])).toMatch(/^invalid: /);
  });

  it("applies the job's own check and puts its message in the retry", async () => {
    const { runner, model } = setup((_request, n) =>
      answer(JSON.stringify({ answer: n === 1 ? "no" : "yes" })),
    );
    const result = await runner.run(
      request({ check: (output) => (output.answer === "no" ? "Never say no." : undefined) }),
    );
    expect(result.ok).toBe(true);
    expect(model.calls[1]?.messages.at(-1)?.content).toContain("Never say no.");
  });

  it("sends the JSON schema derived from the zod schema, without the $schema marker", async () => {
    const { runner, model } = setup(() => answer(GOOD));
    await runner.run(request());
    const schema = model.calls[0]?.schema;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(schema).not.toHaveProperty("$schema");
  });

  it("does not retry when the runtime is unavailable", async () => {
    const { runner, model } = setup(() => {
      throw new ModelUnavailableError("down");
    });
    const result = await runner.run(request());
    expect(result).toMatchObject({ ok: false, failure: "unavailable", calls: 1, retries: 0 });
    expect(model.calls).toHaveLength(1);
    expect(String(decisions()[0]?.["error"])).toContain("unavailable");
  });

  it("writes one structured log line per job with ids and numbers, never the input text", async () => {
    const { runner } = setup(() => answer(GOOD));
    const lines: unknown[] = [];
    runner.setLogger((entry) => lines.push(entry));
    await runner.run(request());
    expect(lines).toEqual([
      expect.objectContaining({
        job: "test",
        model: "test-model",
        promptVersion: "test.v1",
        valid: true,
        retries: 0,
        calls: 1,
        failure: null,
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("private household text");
  });
});

describe("Gemma job runner: timeouts, deadline and the queue (NFR-004)", () => {
  it("passes a 30 s timeout to each model call", async () => {
    const { runner, model } = setup(() => answer(GOOD));
    await runner.run(request());
    expect(model.calls[0]?.timeoutMs).toBe(30_000);
  });

  it("gives up on a model that never answers after the per-call timeout", async () => {
    const { runner } = setup(() => new Promise<ChatResponse>(() => undefined), {
      callTimeoutMs: 20,
    });
    const result = await runner.run(request());
    expect(result).toMatchObject({ ok: false, failure: "timeout", calls: 1 });
  });

  it("measures the 45 s deadline from enqueue: a job that waited in the queue gets less time", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, model, clock } = setup(async (_request, n) => {
      if (n === 1) {
        await held;
      }
      return answer(GOOD);
    });
    const first = runner.run(request());
    const second = runner.run(request());
    await tick();
    clock.advance(20_000);
    release();
    await Promise.all([first, second]);
    // The first job started at once with the full 30 s; the second started 20 s after it was
    // queued, so 25 s of its 45 s are left.
    expect(model.calls[0]?.timeoutMs).toBe(30_000);
    expect(model.calls[1]?.timeoutMs).toBe(25_000);
  });

  it("fails with the deadline, without a model call, when the queue wait used it all", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, model, clock } = setup(async (_request, n) => {
      if (n === 1) {
        await held;
      }
      return answer(GOOD);
    });
    const first = runner.run(request());
    const second = runner.run(request());
    await tick();
    clock.advance(46_000);
    release();
    const [, late] = await Promise.all([first, second]);
    expect(late).toMatchObject({ ok: false, failure: "deadline", calls: 0 });
    expect(model.calls).toHaveLength(1);
    expect(decisions()[1]).toMatchObject({ valid: 0 });
    expect(String(decisions()[1]?.["error"])).toMatch(/^deadline: /);
  });

  it("shares one deadline when the caller passes the enqueue time (inspector + bookmaker)", async () => {
    const { runner, clock } = setup(() => answer(GOOD));
    const enqueuedAt = clock.now();
    clock.advance(44_000);
    const result = await runner.run(request({ enqueuedAt }));
    expect(result.ok).toBe(true);
    clock.advance(2_000);
    const late = await runner.run(request({ enqueuedAt }));
    expect(late).toMatchObject({ ok: false, failure: "deadline" });
  });

  it("runs jobs one at a time, first in first out", async () => {
    const order: string[] = [];
    let running = 0;
    let peak = 0;
    const { runner } = setup(async (callRequest) => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(callRequest.messages[1]?.content ?? "");
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return answer(GOOD);
    });
    await Promise.all(["a", "b", "c"].map((text) => runner.run(request({ user: text }))));
    expect(order).toEqual(["a", "b", "c"]);
    expect(peak).toBe(1);
    await runner.idle();
    expect(runner.queued).toBe(0);
  });
});

describe("Gemma job runner: the tool loop (AC-003.1, AC-003.6)", () => {
  it("AC-003.1: offers the tool with the schema, runs Gemma's call and sends the result back", async () => {
    const executed: unknown[] = [];
    const { runner, model } = setup((_request, n) => (n === 1 ? callTool() : answer(GOOD)));
    const result = await runner.run(request({ tool: tool(true, executed) }));
    expect(result).toMatchObject({ ok: true, toolMode: "called", calls: 2 });
    expect(executed).toEqual([{ hours_ahead: 12 }]);
    expect(model.calls[0]?.tools?.map((t) => t.name)).toEqual(["get_forecast"]);
    expect(model.calls[0]?.schema).toBeDefined();
    const second = model.calls[1];
    expect(second?.tools).toBeUndefined();
    expect(second?.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(second?.messages[3]).toMatchObject({ toolName: "get_forecast" });
    expect(second?.messages[3]?.content).toContain("<untrusted_data>");
    expect(decisions()[0]).toMatchObject({ tool_mode: "called" });
  });

  it("AC-003.6: no tool call -> one retry that says so -> missed, 2 calls", async () => {
    const { runner, model } = setup(() => answer(GOOD));
    const result = await runner.run(request({ tool: tool(true) }));
    expect(result).toMatchObject({
      ok: false,
      failure: "tool_missed",
      toolMode: "missed",
      calls: 2,
    });
    expect(model.calls[1]?.messages.at(-1)?.content).toContain("get_forecast");
    expect(decisions()[0]).toMatchObject({ tool_mode: "missed", valid: 0 });
  });

  it("AC-003.6: a retry that calls the tool succeeds and the first miss stays on the record", async () => {
    const { runner } = setup((_request, n) =>
      n === 1 ? answer(GOOD) : n === 2 ? callTool() : answer(GOOD),
    );
    const result = await runner.run(request({ tool: tool(true) }));
    expect(result).toMatchObject({ ok: true, toolMode: "called", retries: 1, calls: 3 });
    expect(String(decisions()[0]?.["error"])).toContain("get_forecast");
  });

  it("makes at most 4 model calls: tool call and invalid answer, twice", async () => {
    const { runner, model } = setup((_request, n) => (n % 2 === 1 ? callTool() : answer("nope")));
    const result = await runner.run(request({ tool: tool(true) }));
    expect(result).toMatchObject({ ok: false, failure: "invalid", calls: MAX_MODEL_CALLS });
    expect(model.calls).toHaveLength(4);
  });

  it("allows two tool calls per job and refuses the third with a message", async () => {
    const executed: unknown[] = [];
    const { runner, model } = setup((_request, n) =>
      n === 1
        ? answer("", {
            toolCalls: [
              { name: "get_forecast", arguments: { hours_ahead: 6 } },
              { name: "get_forecast", arguments: { hours_ahead: 12 } },
              { name: "get_forecast", arguments: { hours_ahead: 24 } },
            ],
          })
        : answer(GOOD),
    );
    await runner.run(request({ tool: tool(true, executed) }));
    expect(executed).toHaveLength(2);
    const toolMessages = model.calls[1]?.messages.filter((m) => m.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[2]?.content).toContain("Too many tool calls");
  });

  it("AC-003.6: an unknown tool name is not a use of the tool: nothing runs, it is a miss and a retry", async () => {
    const executed: unknown[] = [];
    const { runner, model } = setup((_request, n) =>
      n === 1
        ? answer("", { toolCalls: [{ name: "delete_everything", arguments: {} }] })
        : n === 2
          ? callTool()
          : answer(GOOD),
    );
    const result = await runner.run(request({ tool: tool(true, executed) }));
    expect(executed).toEqual([{ hours_ahead: 12 }]);
    expect(result).toMatchObject({ ok: true, toolMode: "called", retries: 1, calls: 3 });
    expect(model.calls[1]?.messages.at(-1)?.content).toContain("get_forecast");
  });

  it("AC-003.6: wrong-named calls twice end as tool_missed, tool_mode missed, with no answer call", async () => {
    const executed: unknown[] = [];
    const { runner, model } = setup(() =>
      answer("", { toolCalls: [{ name: "delete_everything", arguments: {} }] }),
    );
    const result = await runner.run(request({ tool: tool(true, executed) }));
    expect(result).toMatchObject({
      ok: false,
      failure: "tool_missed",
      toolMode: "missed",
      calls: 2,
    });
    expect(executed).toEqual([]);
    expect(model.calls).toHaveLength(2);
    expect(decisions()[0]).toMatchObject({ tool_mode: "missed" });
  });

  it("AC-003.6: arguments the tool rejects are not a use of the tool either", async () => {
    const rejecting: JobTool = {
      ...tool(true),
      execute: () => Promise.reject(new JobToolArgumentError("hours_ahead must be 1 to 48")),
    };
    const { runner } = setup(() => callTool({ hours_ahead: 99 }));
    const result = await runner.run(request({ tool: rejecting }));
    expect(result).toMatchObject({ ok: false, failure: "tool_missed", toolMode: "missed" });
  });

  it("fails with tool_error, without a retry, when the tool cannot run", async () => {
    const broken: JobTool = {
      ...tool(true),
      execute: () => Promise.reject(new JobToolError("no forecast")),
    };
    const { runner } = setup(() => callTool());
    const result = await runner.run(request({ tool: broken }));
    expect(result).toMatchObject({ ok: false, failure: "tool_error", calls: 1 });
  });

  it("accepts an answer without a call when the tool is not required", async () => {
    const { runner } = setup(() => answer(GOOD));
    const result = await runner.run(request({ tool: tool(false) }));
    expect(result).toMatchObject({ ok: true, calls: 1 });
  });

  it("two_step mode: the tool goes first without the schema, the schema comes with the answer", async () => {
    const { runner, model } = setup((_request, n) => (n === 1 ? callTool() : answer(GOOD)), {
      answerMode: "two_step",
    });
    const result = await runner.run(request({ tool: tool(true) }));
    expect(result.ok).toBe(true);
    expect(model.calls[0]?.tools).toBeDefined();
    expect(model.calls[0]?.schema).toBeUndefined();
    expect(model.calls[1]?.schema).toBeDefined();
  });

  it("injected mode: the app makes the call, passes the result, and records tool_mode = injected", async () => {
    const executed: unknown[] = [];
    const { runner, model } = setup(() => answer(GOOD), { toolUse: "injected" });
    const result = await runner.run(request({ tool: tool(true, executed) }));
    expect(result).toMatchObject({ ok: true, toolMode: "injected", calls: 1 });
    expect(executed).toEqual([{ hours_ahead: 24 }]);
    const messages = model.calls[0]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(messages[2]?.toolCalls?.[0]).toMatchObject({ name: "get_forecast" });
    expect(model.calls[0]?.tools).toBeUndefined();
    expect(decisions()[0]).toMatchObject({ tool_mode: "injected" });
  });

  it("injected mode makes the call once for a job, also across the retry", async () => {
    const executed: unknown[] = [];
    const { runner } = setup((_request, n) => answer(n === 1 ? "bad" : GOOD), {
      toolUse: "injected",
    });
    const result = await runner.run(request({ tool: tool(true, executed) }));
    expect(result).toMatchObject({ ok: true, retries: 1, calls: 2, toolMode: "injected" });
    expect(executed).toHaveLength(1);
  });
});

describe("the judge runs on the job runner (T-004's judge moved onto it)", () => {
  it("retries once with the validation error and logs the decision with the bet", async () => {
    const { runner, model } = setup((_request, n) =>
      answer(
        n === 1
          ? '{"status":"ok","reason":"x"}'
          : JSON.stringify({ status: "ok", verdict: "win", reason: "Still moist." }),
      ),
    );
    db.exec(`INSERT INTO cards (id, input_text, chore_type, kind, created_at) VALUES (1, 'c', 'plants', 'weather', 1);
      INSERT INTO bets (id, card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at)
        VALUES (1, 1, 'do_nothing', 2, 50, 'rule', 'r', 2, 1, 2, 3);`);
    const result = await judgeBet(runner, {
      chore: CHORES.plants,
      kind: "do_nothing",
      odds: 50,
      evidence: { kind: "tap", answerId: "moist" },
      weather: null,
      followups: [],
      canAsk: true,
      betId: 1,
      cardId: 1,
    });
    expect(result).toMatchObject({ ok: true, verdict: "win" });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.messages.at(-1)?.content).toContain("verdict");
    expect(decisions()[0]).toMatchObject({
      job: "judge",
      bet_id: 1,
      card_id: 1,
      retries: 1,
      valid: 1,
    });
  });
});

describe("Gemma job runner: the retry message, internal errors and the bounded queue", () => {
  it("quotes the rejected answer, cut to 300 characters, next to the validation error", async () => {
    const long = JSON.stringify({ answer: "maybe", pad: "z".repeat(900) });
    const { runner, model } = setup((_request, n) => answer(n === 1 ? long : GOOD));
    await runner.run(request());
    const retry = model.calls[1]?.messages.at(-1)?.content ?? "";
    expect(retry).toContain("rejected");
    expect(retry).toContain("previous_answer");
    expect(retry).toContain("maybe");
    expect(retry.match(/z/g)?.length).toBeLessThan(300);
    expect(retry.match(/<\/untrusted_data>/g)).toHaveLength(1);
  });

  it("an exception from the model client becomes an internal failure with a decision row", async () => {
    const { runner } = setup(() => {
      throw new Error("fixture exploded");
    });
    const result = await runner.run(request());
    expect(result).toMatchObject({ ok: false, failure: "internal" });
    expect(decisions()).toEqual([
      expect.objectContaining({ valid: 0, error: "internal: fixture exploded" }),
    ]);
    expect(runner.queued).toBe(0);
  });

  it("an exception from the job's own check is an internal failure too", async () => {
    const { runner } = setup(() => answer(GOOD));
    const result = await runner.run(
      request({
        check: () => {
          throw new Error("check bug");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, failure: "internal" });
    expect(decisions()).toHaveLength(1);
  });

  it("refuses new jobs with JobQueueFullError when 8 are queued or running, then recovers", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner } = setup(async () => {
      await held;
      return answer(GOOD);
    });
    const jobs = Array.from({ length: MAX_QUEUED_JOBS }, () => runner.run(request()));
    expect(runner.full).toBe(true);
    await expect(runner.run(request())).rejects.toBeInstanceOf(JobQueueFullError);
    release();
    await Promise.all(jobs);
    expect(runner.full).toBe(false);
    expect((await runner.run(request())).ok).toBe(true);
  });
});
