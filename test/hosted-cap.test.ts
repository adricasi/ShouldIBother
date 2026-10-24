import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { JobRunner } from "../src/server/gemma/runner.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import {
  CappedModelClient,
  VERDICTS_FIRST_MAX_MS,
  type ModelCapLogEntry,
} from "../src/server/model/capped.js";
import {
  ModelBusyError,
  ModelCapReachedError,
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
import { HOUR, seedBet, settlementOf, tap } from "./support/settle.js";

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
    expect(failure).toBeInstanceOf(ModelCapReachedError);
    expect(failure).toBeInstanceOf(ModelUnavailableError);
    expect(failure).not.toBeInstanceOf(ModelDailyLimitError);
    await expect(model.chat(call("judge"))).rejects.toBeInstanceOf(ModelCapReachedError);
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

  it("floor(cap * 0.8) is the limit of the other jobs: a cap of 7 leaves them 5 calls and verdicts 2", async () => {
    setup();
    const model = capped(7);
    for (let index = 0; index < 5; index += 1) {
      await model.chat(call("advisor"));
    }
    await expect(model.chat(call("advisor"))).rejects.toBeInstanceOf(ModelDailyLimitError);
    await model.chat(call("judge"));
    await model.chat(call("judge"));
    await expect(model.chat(call("judge"))).rejects.toBeInstanceOf(ModelCapReachedError);
    expect(inner.calls).toBe(7);
  });

  it("counts the 25-hour day when the clocks go back (25 Oct 2026) as one Madrid date", async () => {
    setup();
    const model = capped(100);
    // 00:30 CEST on the 25th, and 23:30 CET the same date, 24 h later by the wall clock.
    clock.current = Date.UTC(2026, 9, 24, 22, 30);
    await model.chat(call("listener"));
    clock.current = Date.UTC(2026, 9, 25, 22, 30);
    await model.chat(call("listener"));
    expect(db.prepare("SELECT day, calls FROM model_calls ORDER BY day").all()).toEqual([
      { day: "2026-10-25", calls: 2 },
    ]);
    // The next date starts at 00:00 CET, i.e. 23:00 UTC.
    clock.current = Date.UTC(2026, 9, 25, 23, 0);
    await model.chat(call("listener"));
    expect(model.callsToday()).toBe(1);
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

describe("AC-032.5: requests the client would refuse, and the verdicts-first hold", () => {
  it("a request the inner client refuses is not counted: a photo with vision off never uses the cap", async () => {
    setup();
    const refusing: ModelClient = {
      chat: () => Promise.reject(new Error("must not be reached")),
      health: () => Promise.resolve({ state: "online" }),
      refuses: (request) =>
        request.images === undefined ? undefined : "photos are not sent to DigitalOcean",
    };
    const model = new CappedModelClient(refusing, { db, now: clock.now, cap: 10 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await expect(model.chat({ ...call("judge"), images: [new Uint8Array([1])] })).rejects.toThrow(
        "photos are not sent",
      );
    }
    expect(model.callsToday()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_calls").get()).toEqual({ n: 0 });
  });

  it("the hold ends when no verdict is callable any more (all done or in back-off)", async () => {
    setup();
    const model = capped(10);
    waiting = 1;
    await expect(model.chat(call("bookmaker"))).rejects.toBeInstanceOf(ModelBusyError);
    waiting = 0; // the one verdict went into its retry back-off, or was settled
    await model.chat(call("bookmaker"));
    expect(inner.calls).toBe(1);
  });

  it("the hold ends after ten minutes even if a verdict still waits", async () => {
    setup();
    const model = capped(10);
    waiting = 1;
    await expect(model.chat(call("bookmaker"))).rejects.toBeInstanceOf(ModelBusyError);
    clock.advance(VERDICTS_FIRST_MAX_MS - 1_000);
    await expect(model.chat(call("bookmaker"))).rejects.toBeInstanceOf(ModelBusyError);
    clock.advance(1_000);
    await model.chat(call("bookmaker"));
    expect(inner.calls).toBe(1);
    // The next Madrid day holds again, for its own ten minutes.
    clock.current += DAY;
    await expect(model.chat(call("bookmaker"))).rejects.toBeInstanceOf(ModelBusyError);
  });
});

describe("AC-032.5: what the jobs and cards do over the cap", () => {
  it("the job runner reports daily_limit for a card job and cap_reached for a verdict", async () => {
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
    expect(verdict).toMatchObject({ ok: false, failure: "cap_reached", calls: 2 });
    const next = await run("judge");
    expect(next).toMatchObject({ ok: false, failure: "cap_reached" });
    expect(inner.calls).toBe(5);
  });
});

describe("AC-032.5: a verdict at the cap waits and says so", () => {
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

  it("shows the daily-limit words on the settle screen, then settles first after midnight (Madrid)", async () => {
    dir = mkdtempSync(join(tmpdir(), "sib-cap-verdict-"));
    const path = join(dir, "sib.db");
    const clockForCap = new FakeClock();
    clockForCap.current = Date.UTC(2026, 9, 22, 21, 50); // 23:50 in Madrid
    const capDb = openDatabase(path);
    migrate(capDb, MIGRATIONS);
    capDb
      .prepare("INSERT INTO model_calls (day, calls, judge_calls) VALUES ('2026-10-22', 10, 4)")
      .run();
    const fakeModel = new FakeModelClient({ scenario: judgeScenarioFromAnswer });
    const model = new CappedModelClient(fakeModel, { db: capDb, now: clockForCap.now, cap: 10 });
    harness = await createCoreHarness({
      dbPath: path,
      clock: clockForCap,
      model: model as unknown as FakeModelClient,
    });
    await pair(harness);
    const betId = seedBet(harness, { settleOffsetMs: -2 * HOUR });
    expect(await tap(harness, betId, "moist")).toMatchObject({
      status: 202,
      body: { state: "awaiting_gemma" },
    });
    expect(harness.db.prepare("SELECT failure FROM settle_progress").get()).toEqual({
      failure: "cap_reached",
    });
    const slips = (await harness.get("/api/slips")).json<{
      settle_now: { id: number; settle: { note: string } }[];
    }>();
    expect(slips.settle_now.find((bet) => bet.id === betId)?.settle.note).toBe(
      "Gemma's daily limit is used up; this settles after midnight (Madrid).",
    );
    expect(fakeModel.calls).toHaveLength(0);

    clockForCap.current += 20 * 60 * 1000; // 00:10 in Madrid, the next date
    await harness.core.scheduler.tickSettlement();
    expect(settlementOf(harness, betId)).toMatchObject({ evidence: "tap" });
    capDb.close();
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
