import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FAKE_WEATHER_PROFILES, type FakeWeatherProfile } from "../src/server/weather/fake.js";

import {
  createCoreHarness,
  pair,
  type CoreHarness,
  type CoreHarnessOptions,
} from "./core-helpers.js";
import { HoldableModel, type BetJson, type CardJson } from "./gemma-support.js";
import { T0 } from "./helpers.js";

const HOUR = 3_600_000;

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

async function setup(
  options: {
    model?: HoldableModel;
    weatherProfile?: FakeWeatherProfile;
    dbPath?: string;
    runner?: CoreHarnessOptions["runner"];
  } = {},
): Promise<{ h: CoreHarness; model: HoldableModel }> {
  const model = options.model ?? new HoldableModel();
  harness = await createCoreHarness({
    model,
    weatherProfile: options.weatherProfile ?? FAKE_WEATHER_PROFILES.mild,
    ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  await pair(harness);
  return { h: harness, model };
}

async function quickCard(h: CoreHarness): Promise<CardJson> {
  const response = await h.post("/api/cards/quick", { chore_type: "plants" });
  expect(response.statusCode).toBe(201);
  return response.json<CardJson>();
}

async function card(h: CoreHarness, id: number): Promise<CardJson> {
  return (await h.get(`/api/cards/${id}`)).json<CardJson>();
}

/** Creates a card and waits for the bookmaker to finish. */
async function settledCard(h: CoreHarness): Promise<CardJson> {
  const created = await quickCard(h);
  await h.idle();
  return card(h, created.id);
}

const quotes = (h: CoreHarness) =>
  h.db
    .prepare<[], { source: string; band: number; settle_at: number; decision_id: number | null }>(
      "SELECT source, band, settle_at, decision_id FROM quotes ORDER BY id",
    )
    .all();
const decisions = (h: CoreHarness, job = "bookmaker") =>
  h.db
    .prepare<[string], Record<string, unknown>>(
      "SELECT * FROM gemma_decisions WHERE job = ? ORDER BY id",
    )
    .all(job);

describe("REQ-013: rule odds at once, Gemma's odds when they arrive", () => {
  it("AC-013.1: a new weather card shows the rule band at once, labelled 'Gemma is thinking · rule odds'", async () => {
    const { h, model } = await setup();
    model.hold();
    const created = await quickCard(h);
    expect(created.quote).toMatchObject({
      source: "rule",
      provisional: true,
      label: "Gemma is thinking · rule odds",
    });
    expect(created.gemma).toMatchObject({ state: "thinking", can_retry: false });
    const today = (await h.get("/api/today")).json<{ cards: CardJson[] }>();
    expect(today.cards[0]?.quote?.label).toBe("Gemma is thinking · rule odds");
    model.release();
    await h.idle();
  });

  it("AC-013.2, AC-003.2: Gemma's answer replaces the rule band, reason and settle time, labelled 'Gemma's odds'", async () => {
    const { h, model } = await setup();
    model.hold();
    const created = await quickCard(h);
    model.release();
    await h.idle();
    const after = await card(h, created.id);
    expect(after.gemma).toMatchObject({ state: "answered", can_retry: false });
    expect(after.quote).toMatchObject({
      source: "gemma",
      label: "Gemma's odds",
      provisional: false,
      band: 2,
      band_name: "toss-up",
      odds: 50,
      reason: "Showers are possible overnight, so the pots may stay moist enough.",
      settle_at: new Date(T0 + 24 * HOUR).toISOString(),
    });
    // AC-003.2: the payout for each outcome comes with the quote.
    expect(after.quote?.payouts).toMatchObject({
      win_with_photo: 50,
      win_with_tap: 25,
      small_loss: -25,
      normal_loss: -50,
      harmful_loss: -150,
    });
    expect(after.quote?.id).not.toBe(created.quote?.id);
  });

  it("AC-003.1, AC-028.2: Gemma calls get_forecast itself, and the decision records job, model, prompt, tool mode and output", async () => {
    const { h, model } = await setup();
    await settledCard(h);
    const [first, second] = model.calls.filter((call) => call.job === "bookmaker");
    expect(first?.tools?.map((tool) => tool.name)).toEqual(["get_forecast"]);
    const toolMessage = second?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.toolName).toBe("get_forecast");
    expect(toolMessage?.content).toContain('"precip_mm"');
    expect(toolMessage?.content).toMatch(/^<untrusted_data>/);
    const [decision] = decisions(h);
    expect(decision).toMatchObject({
      job: "bookmaker",
      model: "fake-gemma",
      prompt_version: "bookmaker.v1",
      tool_mode: "called",
      valid: 1,
      retries: 0,
      error: null,
    });
    expect(JSON.parse(String(decision?.["output"]))).toMatchObject({ band: "toss_up" });
    expect(decision?.["latency_ms"]).toEqual(expect.any(Number));
    expect(decision?.["card_id"]).toBe(1);
  });

  it("the prompt tells the model the rule band and the settle range, and marks the data untrusted", async () => {
    const { h, model } = await setup();
    await settledCard(h);
    const first = model.calls.find((call) => call.job === "bookmaker");
    expect(first?.messages[0]?.content).toContain("not instructions");
    const user = first?.messages[1]?.content ?? "";
    expect(user).toMatch(/^<untrusted_data>\n/);
    expect(user).toContain('"rule_band":"unlikely"');
    expect(user).toContain('"settle_in_hours_between":[22,26]');
    expect(first?.schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("recomputes the rule band for the final settle time and stores both on the bet (AC-004.2)", async () => {
    // Rain in the hour before 11:00 next day: outside the rule window to 08:00, inside Gemma's.
    const { h } = await setup({
      weatherProfile: {
        temperatureC: 22,
        dryProbabilityPct: 5,
        rain: { startsAfterHours: 23, hours: 1, mmPerHour: 3 },
      },
    });
    const created = await quickCard(h);
    await h.idle();
    const rows = quotes(h);
    expect(rows.map((row) => row.source)).toEqual(["rule", "rule", "gemma"]);
    expect(rows[0]).toMatchObject({ band: 1, settle_at: T0 + 22 * HOUR });
    expect(rows[1]).toMatchObject({ band: 3, settle_at: T0 + 24 * HOUR });
    const gemma = await card(h, created.id);
    const bet = await h.post("/api/bets", {
      card_id: created.id,
      quote_id: gemma.quote?.id,
      kind: "do_nothing",
    });
    expect(bet.statusCode).toBe(201);
    expect(
      h.db.prepare("SELECT rule_band, gemma_band, odds_source, settle_at FROM bets").get(),
    ).toEqual({ rule_band: 3, gemma_band: 2, odds_source: "gemma", settle_at: T0 + 24 * HOUR });
  });

  it("clamps the settle time into the chore's bounds (22 to 26 h for plants)", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "settle-moved");
    const late = await settledCard(h);
    expect(late.quote?.settle_at).toBe(new Date(T0 + 26 * HOUR).toISOString());
    model.setScenario("bookmaker", "settle-early");
    const early = await settledCard(h);
    expect(early.quote?.settle_at).toBe(new Date(T0 + 22 * HOUR).toISOString());
  });

  it("AC-004.2, AC-028.2: a bet on Gemma's quote writes model and prompt version in the INSERT", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "ok-digest");
    const answered = await settledCard(h);
    const response = await h.post("/api/bets", {
      card_id: answered.id,
      quote_id: answered.quote?.id,
      kind: "do_nothing",
    });
    expect(response.json<BetJson>()).toMatchObject({ odds_source: "gemma", odds: 50 });
    expect(
      h.db.prepare("SELECT gemma_band, rule_band, model_version, prompt_version FROM bets").get(),
    ).toEqual({
      gemma_band: 2,
      rule_band: 1,
      model_version: "fake-gemma@sha256:synthetic0001",
      prompt_version: "bookmaker.v1",
    });
  });

  it("AC-006.2: an answer that arrives after a bet is placed does not touch the bet or add a quote", async () => {
    const { h, model } = await setup();
    model.hold();
    const created = await quickCard(h);
    const bet = await h.post("/api/bets", {
      card_id: created.id,
      quote_id: created.quote?.id,
      kind: "do_nothing",
    });
    expect(bet.statusCode).toBe(201);
    model.release();
    await h.idle();
    expect(quotes(h).filter((row) => row.source === "gemma")).toEqual([]);
    expect(h.db.prepare("SELECT odds_source, band, model_version FROM bets").get()).toEqual({
      odds_source: "rule",
      band: 1,
      model_version: null,
    });
  });

  it("a bet on a quote that Gemma has since replaced is refused so the person confirms the new odds", async () => {
    const { h } = await setup();
    const created = await quickCard(h);
    await h.idle();
    const stale = await h.post("/api/bets", {
      card_id: created.id,
      quote_id: created.quote?.id,
      kind: "do_nothing",
    });
    expect(stale.statusCode).toBe(409);
  });
});

describe("REQ-003: unsure, validation and tool use", () => {
  it("AC-003.3: an 'unsure' answer shows its yes/no question as two taps, and the tap re-asks the bookmaker", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "unsure");
    const asking = await settledCard(h);
    expect(asking.gemma).toMatchObject({
      state: "question",
      question: "Are the pots under a roof?",
      can_retry: false,
    });
    expect(asking.quote).toMatchObject({
      source: "rule",
      label: "Gemma has a question · rule odds",
    });

    model.setScenario("bookmaker", "ok");
    const answered = await h.post(`/api/cards/${asking.id}/answer`, { yes: true });
    expect(answered.statusCode).toBe(200);
    expect(answered.json<CardJson>().gemma?.state).toBe("thinking");
    await h.idle();
    expect((await card(h, asking.id)).quote?.source).toBe("gemma");
    const reasked = model.calls.filter((call) => call.job === "bookmaker").at(-2);
    const user = reasked?.messages[1]?.content ?? "";
    expect(user).toContain("Are the pots under a roof?");
    expect(user).toContain('"answer":"yes"');
  });

  it("AC-003.3: a card with no question refuses an answer; a bad body is a 400", async () => {
    const { h } = await setup();
    const answered = await settledCard(h);
    expect((await h.post(`/api/cards/${answered.id}/answer`, { yes: true })).statusCode).toBe(409);
    expect((await h.post(`/api/cards/${answered.id}/answer`, { yes: "maybe" })).statusCode).toBe(
      400,
    );
  });

  it.each(["invalid-json", "invalid-schema", "too-long-reason"])(
    "AC-003.4: %s after the retry keeps the rule odds, logs the failure and offers Retry",
    async (scenario) => {
      const { h, model } = await setup();
      model.setScenario("bookmaker", scenario);
      const after = await settledCard(h);
      expect(after.quote).toMatchObject({ source: "rule", label: "Gemma offline · rule odds" });
      expect(after.gemma).toMatchObject({ state: "offline", can_retry: true });
      expect(after.gemma?.note).toBe("Gemma's answer did not pass the checks.");
      expect(model.calls.filter((call) => call.job === "bookmaker")).toHaveLength(4);
      expect(decisions(h)[0]).toMatchObject({ valid: 0, retries: 1 });
      expect(String(decisions(h)[0]?.["error"])).toMatch(/^invalid: /);
    },
  );

  it("AC-003.4: an invalid first answer is retried with the validation error and can still succeed", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "invalid-then-valid");
    const after = await settledCard(h);
    expect(after.quote?.source).toBe("gemma");
    expect(decisions(h)[0]).toMatchObject({ valid: 1, retries: 1 });
    const retryCall = model.calls.filter((call) => call.job === "bookmaker")[2];
    expect(retryCall?.messages.at(-1)?.content).toContain("not valid JSON");
  });

  it("AC-003.6: an answer without get_forecast is retried once, then the rule odds stay and the miss is recorded", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "no-tool-call");
    const after = await settledCard(h);
    expect(model.calls.filter((call) => call.job === "bookmaker")).toHaveLength(2);
    expect(after.quote).toMatchObject({ source: "rule", label: "Gemma offline · rule odds" });
    expect(after.gemma).toMatchObject({ state: "offline", can_retry: true });
    expect(after.gemma?.note).toBe("Gemma answered without looking at the forecast.");
    expect(decisions(h)[0]).toMatchObject({ tool_mode: "missed", valid: 0 });
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM gemma_decisions WHERE tool_mode = 'missed'").get(),
    ).toEqual({ n: 1 });
  });

  it("AC-003.6: when the retry calls the tool the answer is used", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "no-tool-call-then-tool");
    const after = await settledCard(h);
    expect(after.quote?.source).toBe("gemma");
    expect(decisions(h)[0]).toMatchObject({ tool_mode: "called", retries: 1, valid: 1 });
    expect(model.calls.filter((call) => call.job === "bookmaker")).toHaveLength(3);
  });

  it("allows two tool calls and refuses the third with a message", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "three-tool-calls");
    expect((await settledCard(h)).quote?.source).toBe("gemma");
    const second = model.calls.filter((call) => call.job === "bookmaker")[1];
    const results = second?.messages.filter((message) => message.role === "tool") ?? [];
    expect(results.map((message) => message.content.slice(0, 18))).toEqual([
      "<untrusted_data>\n{",
      "<untrusted_data>\n{",
      "Too many tool call",
    ]);
  });

  it("AC-003.6: a bad hours_ahead is not a use of the tool: retried, then the answer counts as called", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "bad-tool-arguments");
    expect((await settledCard(h)).quote?.source).toBe("gemma");
    expect(decisions(h)[0]).toMatchObject({ tool_mode: "called", retries: 1, valid: 1 });
    expect(model.calls.filter((call) => call.job === "bookmaker")).toHaveLength(3);
  });

  it("AC-003.6: calls to a tool that does not exist end with the rule odds and a recorded miss", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "wrong-tool-name");
    const after = await settledCard(h);
    expect(after.quote?.source).toBe("rule");
    expect(after.gemma).toMatchObject({ state: "offline", can_retry: true });
    expect(decisions(h)[0]).toMatchObject({ tool_mode: "missed", valid: 0 });
  });

  it("injected-forecast fallback: the app makes the get_forecast call and records tool_mode = injected", async () => {
    const { h, model } = await setup({ runner: { toolUse: "injected" } });
    model.setScenario("bookmaker", "injected");
    const after = await settledCard(h);
    expect(after.quote?.source).toBe("gemma");
    const calls = model.calls.filter((call) => call.job === "bookmaker");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toBeUndefined();
    expect(calls[0]?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(decisions(h)[0]).toMatchObject({ tool_mode: "injected", valid: 1 });
  });
});

describe("REQ-004: Gemma against the rule band (AC-004.3)", () => {
  const hot = FAKE_WEATHER_PROFILES.hot; // rule band 0, very unlikely

  it("AC-004.3: two or more bands from the rule with no explanation and no question is invalid", async () => {
    const { h, model } = await setup({ weatherProfile: hot });
    model.setScenario("bookmaker", "disagreement-without-reason");
    const after = await settledCard(h);
    expect(after.quote?.source).toBe("rule");
    expect(after.gemma).toMatchObject({ state: "offline", can_retry: true });
    expect(decisions(h)[0]).toMatchObject({ valid: 0, retries: 1 });
    const retry = model.calls.filter((call) => call.job === "bookmaker")[2];
    expect(retry?.messages.at(-1)?.content).toContain("disagreement_reason");
  });

  it("AC-004.3: the retry can add the explanation", async () => {
    const { h, model } = await setup({ weatherProfile: hot });
    model.setScenario("bookmaker", "disagreement-then-reason");
    const after = await settledCard(h);
    expect(after.quote).toMatchObject({ source: "gemma", band: 4 });
    expect(after.quote?.reason).toContain("Differs from the rule: The rule only counts rain");
  });

  it("AC-004.3: a non-empty disagreement explanation is accepted", async () => {
    const { h, model } = await setup({ weatherProfile: hot });
    model.setScenario("bookmaker", "disagreement-with-reason");
    const after = await settledCard(h);
    expect(after.quote).toMatchObject({ source: "gemma", band: 4, odds: 85 });
    expect(after.gemma?.state).toBe("answered");
  });

  it("AC-004.3: a yes/no question instead of an explanation is accepted and asked of the person", async () => {
    const { h, model } = await setup({ weatherProfile: hot });
    model.setScenario("bookmaker", "disagreement-with-question");
    const after = await settledCard(h);
    expect(after.gemma).toMatchObject({ state: "question", question: "Is the balcony covered?" });
    expect(after.quote?.source).toBe("rule");
    expect(decisions(h)[0]).toMatchObject({ valid: 1 });
  });

  it("one band apart needs no explanation", async () => {
    const { h } = await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    expect((await settledCard(h)).quote).toMatchObject({ source: "gemma", band: 2 });
  });
});

describe("REQ-013: Gemma offline, slow or retried", () => {
  it.each([
    ["offline", "Gemma is not running."],
    ["timeout", "Gemma took too long to answer."],
  ])(
    "AC-013.3: %s shows 'Gemma offline · rule odds' with Retry, and betting is still allowed",
    async (scenario, note) => {
      const { h, model } = await setup();
      model.setScenario("bookmaker", scenario);
      const after = await settledCard(h);
      expect(after.quote).toMatchObject({
        source: "rule",
        label: "Gemma offline · rule odds",
        provisional: false,
      });
      expect(after.gemma).toEqual({ state: "offline", question: null, note, can_retry: true });
      // No retry on a runtime failure: one call.
      expect(model.calls.filter((call) => call.job === "bookmaker")).toHaveLength(1);

      // AC-013.4: the bet stores odds_source = rule.
      const bet = await h.post("/api/bets", {
        card_id: after.id,
        quote_id: after.quote?.id,
        kind: "do_nothing",
      });
      expect(bet.statusCode).toBe(201);
      expect(h.db.prepare("SELECT odds_source, gemma_band FROM bets").get()).toEqual({
        odds_source: "rule",
        gemma_band: null,
      });
    },
  );

  it("AC-013.3: a job that is not done within its 45 s deadline ends as 'Gemma offline · rule odds'", async () => {
    const { h, model } = await setup();
    model.hold();
    const created = await quickCard(h);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.clock.advance(46_000);
    model.release();
    await h.idle();
    const after = await card(h, created.id);
    expect(after.quote?.label).toBe("Gemma offline · rule odds");
    expect(after.gemma).toMatchObject({
      state: "offline",
      note: "Gemma did not finish in time.",
      can_retry: true,
    });
    expect(decisions(h)[0]).toMatchObject({ valid: 0 });
    expect(String(decisions(h)[0]?.["error"])).toMatch(/^deadline: /);
  });

  it("AC-013.3: a card that waited in the queue past the deadline gets no model call", async () => {
    const { h, model } = await setup();
    model.hold();
    const first = await quickCard(h);
    const second = await quickCard(h);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.clock.advance(46_000);
    model.release();
    await h.idle();
    expect((await card(h, first.id)).gemma?.state).toBe("offline");
    expect((await card(h, second.id)).gemma).toMatchObject({
      state: "offline",
      note: "Gemma did not finish in time.",
    });
    expect(model.calls.filter((call) => call.job === "bookmaker")).toHaveLength(1);
  });

  it("AC-013.3: Retry asks the bookmaker again and Gemma's odds replace the rule odds", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "offline");
    const offline = await settledCard(h);
    model.setScenario("bookmaker", "ok");
    const retried = await h.post(`/api/cards/${offline.id}/retry`, {});
    expect(retried.statusCode).toBe(200);
    expect(retried.json<CardJson>().quote?.label).toBe("Gemma is thinking · rule odds");
    await h.idle();
    expect(await card(h, offline.id)).toMatchObject({
      gemma: { state: "answered" },
      quote: { source: "gemma", label: "Gemma's odds" },
    });
  });

  it("Retry is refused while Gemma is thinking or has answered, and for unknown cards", async () => {
    const { h, model } = await setup();
    model.hold();
    const created = await quickCard(h);
    expect((await h.post(`/api/cards/${created.id}/retry`, {})).statusCode).toBe(409);
    model.release();
    await h.idle();
    expect((await h.post(`/api/cards/${created.id}/retry`, {})).statusCode).toBe(409);
    expect((await h.post("/api/cards/999/retry", {})).statusCode).toBe(404);
  });

  it("NFR-003: a card left 'thinking' by a restart shows rule odds and Retry", async () => {
    dir = mkdtempSync(join(tmpdir(), "sib-gemma-"));
    const dbPath = join(dir, "sib.db");
    const first = await setup({ dbPath });
    first.model.hold();
    const created = await quickCard(first.h);
    await first.h.close();
    harness = undefined;

    const second = await setup({ dbPath });
    const after = await card(second.h, created.id);
    expect(after.gemma).toMatchObject({
      state: "offline",
      note: "The app restarted while Gemma was thinking.",
      can_retry: true,
    });
  });

  it("a card from before migration 0005 (no stored state) shows rule odds and Retry", async () => {
    const { h } = await setup();
    const created = await quickCard(h);
    await h.idle();
    h.db.prepare("UPDATE cards SET gemma_state = NULL").run();
    h.db.prepare("DELETE FROM quotes WHERE source = 'gemma'").run();
    const legacy = await card(h, created.id);
    expect(legacy.gemma).toMatchObject({ state: "offline", can_retry: true });
    expect(legacy.quote?.label).toBe("Gemma offline · rule odds");
  });

  it("never queues a Gemma job for an alert card: the fixed backstop wins (AC-012.1)", async () => {
    const { h, model } = await setup({ weatherProfile: FAKE_WEATHER_PROFILES.heatwave });
    const alert = await quickCard(h);
    await h.idle();
    expect(alert).toMatchObject({ kind: "alert", quote: null, gemma: null });
    expect(model.calls).toEqual([]);
    expect(decisions(h)).toEqual([]);
  });
});

describe("AC-013.5: Gemma's status on Today", () => {
  async function status(h: CoreHarness): Promise<{ status: string; detail: string | null }> {
    return (await h.get("/api/today")).json<{ gemma: { status: string; detail: string | null } }>()
      .gemma;
  }

  it("shows online, waking up and offline, refreshed within 60 s", async () => {
    const { h, model } = await setup();
    expect(await status(h)).toMatchObject({ status: "online" });

    model.setHealth("offline");
    // Reused for a few seconds, so Today asking often stays cheap.
    expect(await status(h)).toMatchObject({ status: "online" });
    h.clock.advance(20_000);
    expect(await status(h)).toMatchObject({ status: "offline" });

    model.setHealth("waking");
    h.clock.advance(20_000);
    expect(await status(h)).toMatchObject({ status: "waking" });

    model.setHealth("online");
    h.clock.advance(59_000);
    expect(await status(h)).toMatchObject({ status: "online" });
  });

  it("treats a runtime that does not answer the health check as offline", async () => {
    const { h, model } = await setup();
    model.health = () => Promise.reject(new Error("boom"));
    expect(await status(h)).toMatchObject({ status: "offline" });
  });
});
