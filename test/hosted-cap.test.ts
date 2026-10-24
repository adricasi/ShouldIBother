import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { JobRunner } from "../src/server/gemma/runner.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { CappedModelClient, type ModelCapLogEntry } from "../src/server/model/capped.js";
import {
  ModelBusyError,
  ModelDailyLimitError,
  ModelUnavailableError,
  type ChatRequest,
  type ChatResponse,
  type ModelClient,
} from "../src/server/model/client.js";
import { FakeModelClient } from "../src/server/model/fake.js";
import { judgeScenarioFromAnswer } from "../src/server/fakes.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { FakeClock } from "./helpers.js";

/** A model that counts what reaches it. */
class CountingModel implements ModelClient {
  calls = 0;
  chat(): Promise<ChatResponse> {
    this.calls += 1;
    return Promise.resolve({ content: "{}", toolCalls: [], model: "gemma-4-31B-it" });
  }
  health(): Promise<{ state: "online"; detail: string }> {
    return Promise.resolve({ state: "online", detail: "gemma-4-31B-it" });
  }
}

const call = (job: string): ChatRequest => ({ job, messages: [], timeoutMs: 1_000 });

// 23 Oct 2026, 10:00 Madrid (CEST, UTC+2).
const MORNING = Date.UTC(2026, 9, 23, 8, 0);
const DAY = 24 * 60 * 60 * 1000;

let db: Db;
let clock: FakeClock;
let inner: CountingModel;
let log: ModelCapLogEntry[];
let waiting: number;
let kicks: number;

function capped(cap: number, dbOverride: Db = db): CappedModelClient {
  return new CappedModelClient(inner, {
    db: dbOverride,
    now: clock.now,
    cap,
    log: (entry) => log.push(entry),
    waitingVerdicts: () => waiting,
    runWaitingVerdicts: () => {
      kicks += 1;
    },
  });
}

afterEach(() => {
  db.close();
});

function setup(): void {
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS);
  clock = new FakeClock();
  clock.current = MORNING;
  inner = new CountingModel();
  log = [];
  waiting = 0;
  kicks = 0;
}

describe("AC-032.5: the daily cap on model calls (fake clock)", () => {
  it("counts one call per chat request in SQLite per Madrid date and sends it on", async () => {
    setup();
    const model = capped(10);
    await model.chat(call("bookmaker"));
    await model.chat(call("bookmaker"));
    await model.chat(call("judge"));
    expect(inner.calls).toBe(3);
    expect(model.callsToday()).toBe(3);
    expect(db.prepare("SELECT * FROM model_calls").all()).toEqual([
      { day: "2026-10-23", calls: 3, judge_calls: 1 },
    ]);
    // A new instance (a restart) reads the same count.
    expect(capped(10).callsToday()).toBe(3);
  });

  it("does not count a health check, and says online until the cap is reached", async () => {
    setup();
    const model = capped(10);
    await model.health();
    await model.health();
    expect(model.callsToday()).toBe(0);
    expect(await model.health()).toEqual({ state: "online", detail: "gemma-4-31B-it" });
  });

  it("from 80 % of the cap only the judge calls: the other jobs keep rule odds without a request", async () => {
    setup();
    const model = capped(10);
    for (let index = 0; index < 8; index += 1) {
      await model.chat(call("bookmaker"));
    }
    for (const job of [
      "bookmaker",
      "listener",
      "advisor",
      "laundry-planner",
      "inspector",
      "safety",
    ]) {
      await expect(model.chat(call(job))).rejects.toBeInstanceOf(ModelDailyLimitError);
    }
    expect(inner.calls).toBe(8);
    // The last 20 % is for verdicts.
    await model.chat(call("judge"));
    await model.chat(call("judge"));
    expect(inner.calls).toBe(10);
  });

  it("at the cap the judge waits like Gemma offline, and a retry over the cap is not sent", async () => {
    setup();
    const model = capped(5);
    for (let index = 0; index < 4; index += 1) {
      await model.chat(call("bookmaker"));
    }
    await model.chat(call("judge"));
    const failure = await model.chat(call("judge")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelUnavailableError);
    expect(failure).not.toBeInstanceOf(ModelDailyLimitError);
    await expect(model.chat(call("judge"))).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(inner.calls).toBe(5);
    const health = await model.health();
    expect(health.state).toBe("offline");
  });

  it("starts again at midnight Madrid time, not UTC", async () => {
    setup();
    const model = capped(2);
    clock.current = Date.UTC(2026, 9, 23, 21, 59); // 23:59 Madrid
    await model.chat(call("judge"));
    await model.chat(call("judge"));
    await expect(model.chat(call("judge"))).rejects.toBeInstanceOf(ModelUnavailableError);
    clock.current = Date.UTC(2026, 9, 23, 22, 1); // 00:01 on the 24th in Madrid
    await model.chat(call("judge"));
    expect(inner.calls).toBe(3);
    expect(db.prepare("SELECT day, calls FROM model_calls ORDER BY day").all()).toEqual([
      { day: "2026-10-23", calls: 2 },
      { day: "2026-10-24", calls: 1 },
    ]);
    // The clock moves a day: the count restarts.
    clock.current += DAY;
    expect(model.callsToday()).toBe(0);
  });

  it("after the reset, waiting verdicts run first: the other jobs are held until a verdict was tried", async () => {
    setup();
    const model = capped(10);
    waiting = 2;
    await expect(model.chat(call("bookmaker"))).rejects.toBeInstanceOf(ModelBusyError);
    expect(kicks).toBe(1);
    expect(inner.calls).toBe(0);
    await model.chat(call("judge"));
    await model.chat(call("bookmaker"));
    expect(inner.calls).toBe(2);
    // No verdicts waiting: nothing is held.
    clock.current += DAY;
    waiting = 0;
    await model.chat(call("listener"));
    expect(inner.calls).toBe(3);
  });

  it("logs the cap and the count, never content", async () => {
    setup();
    const model = capped(5);
    for (let index = 0; index < 4; index += 1) {
      await model.chat({
        ...call("bookmaker"),
        messages: [{ role: "user", content: "SECRET CHORE" }],
      });
    }
    await model.chat(call("bookmaker")).catch(() => undefined);
    await model.chat(call("bookmaker")).catch(() => undefined);
    expect(log[0]).toEqual({ event: "model-call", job: "bookmaker", callsToday: 1, cap: 5 });
    const refusals = log.filter((entry) => entry.event === "model-call-refused");
    expect(refusals).toEqual([
      {
        event: "model-call-refused",
        job: "bookmaker",
        callsToday: 4,
        cap: 5,
        reason: "daily-limit",
      },
    ]);
    expect(JSON.stringify(log)).not.toContain("SECRET");
  });
});

describe("AC-032.5: what the jobs and cards do over the cap", () => {
  it("the job runner reports daily_limit for a card job and unavailable for a verdict", async () => {
    setup();
    const model = capped(5);
    for (let index = 0; index < 4; index += 1) {
      await model.chat(call("bookmaker"));
    }
    const runner = new JobRunner({ model, db, now: clock.now });
    const schema = z.object({ a: z.number() });
    const run = (job: string) =>
      runner.run({
        job,
        prompt: { version: "t.v1", text: "t" },
        user: "u",
        schema,
        inputSummary: "test",
      });
    const card = await run("bookmaker");
    expect(card).toMatchObject({ ok: false, failure: "daily_limit", calls: 1 });
    const verdict = await run("judge");
    // The verdict used the last call; "{}" does not fit the schema, and its retry is refused.
    expect(verdict).toMatchObject({ ok: false, failure: "unavailable", calls: 2 });
    const next = await run("judge");
    expect(next).toMatchObject({ ok: false, failure: "unavailable" });
    expect(inner.calls).toBe(5);
  });
});

describe("AC-032.5: a card over the soft limit shows Gemma's daily limit and rule odds", () => {
  let harness: CoreHarness | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("keeps rule odds, names the limit and offers Retry; the next Madrid day answers", async () => {
    dir = mkdtempSync(join(tmpdir(), "sib-cap-"));
    const path = join(dir, "sib.db");
    const clockForCap = new FakeClock();
    clockForCap.current = Date.UTC(2026, 9, 22, 21, 50); // 23:50 in Madrid
    const capDb = openDatabase(path);
    migrate(capDb, MIGRATIONS);
    const fakeModel = new FakeModelClient({ scenario: judgeScenarioFromAnswer });
    // Hosted mode wraps the model in the cap, on a connection to the same database file.
    const model = new CappedModelClient(fakeModel, { db: capDb, now: clockForCap.now, cap: 10 });
    harness = await createCoreHarness({
      dbPath: path,
      clock: clockForCap,
      model: model as unknown as FakeModelClient,
      weatherProfile: FAKE_WEATHER_PROFILES.mild,
    });
    await pair(harness);
    capDb
      .prepare("INSERT INTO model_calls (day, calls, judge_calls) VALUES ('2026-10-22', 8, 0)")
      .run();

    const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
    }>();
    await harness.idle();
    const shown = (await harness.get(`/api/cards/${card.id}`)).json<{
      quote: { source: string } | null;
      gemma: { state: string; note: string | null; can_retry: boolean };
    }>();
    expect(shown.quote?.source).toBe("rule");
    expect(shown.gemma).toMatchObject({
      state: "offline",
      note: "Gemma's daily limit · rule odds",
      can_retry: true,
    });

    // The next Madrid day the cap starts again and Retry gets Gemma's answer.
    clockForCap.current += 20 * 60 * 1000; // 00:10 in Madrid
    const retry = await harness.post(`/api/cards/${card.id}/retry`, {});
    expect(retry.statusCode).toBe(200);
    await harness.idle();
    const retried = (await harness.get(`/api/cards/${card.id}`)).json<{
      gemma: { state: string };
    }>();
    expect(retried.gemma.state).toBe("answered");
    capDb.close();
  });
});
