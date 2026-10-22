import { afterEach, describe, expect, it } from "vitest";

import { winPoints } from "../src/domain/points.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { LOCAL_HOST } from "./helpers.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let harness: CoreHarness;
afterEach(async () => {
  await harness.close();
});

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}): Promise<CoreHarness> {
  harness = await createCoreHarness(options);
  await pair(harness);
  return harness;
}

interface Card {
  id: number;
  title: string;
  quote: {
    id: number;
    source: string;
    band: number;
    band_name: string;
    odds: number;
    label: string;
    provisional: boolean;
    settle_at: string;
    reason: string;
    payouts: Record<string, number>;
  };
}
interface Bet {
  id: number;
  card_id: number;
  status: string;
  odds: number;
  band: number;
  odds_source: string;
  reason: string;
  settle_at: string;
  tap_answers: { id: string; label: string }[];
}
interface Today {
  now: string;
  flags: Record<string, boolean>;
  points: { total: number };
  cards: Card[];
  open_bets: Bet[];
  due_bets: Bet[];
}

async function today(): Promise<Today> {
  return (await harness.get("/api/today")).json<Today>();
}

async function quickCard(): Promise<Card> {
  const response = await harness.post("/api/cards/quick", { chore_type: "plants" });
  expect(response.statusCode).toBe(201);
  return response.json<Card>();
}

async function placeBet(card: Card): Promise<Bet> {
  const response = await harness.post("/api/bets", {
    card_id: card.id,
    quote_id: card.quote.id,
    kind: "do_nothing",
  });
  expect(response.statusCode).toBe(201);
  return response.json<Bet>();
}

/** Moves the fake clock to the bet's settle time and lets the scheduler mark it due. */
function reachSettleTime(bet: Bet): void {
  harness.clock.current = Date.parse(bet.settle_at) + MINUTE;
  harness.core.scheduler.tick();
}

describe("walking skeleton: Water plants, bet, settle by tap, points (fake model, fake clock)", () => {
  it("drives the whole flow", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });

    // Today starts empty.
    expect(await today()).toMatchObject({
      cards: [],
      open_bets: [],
      due_bets: [],
      points: { total: 0 },
    });

    // AC-002.5, AC-004.1, AC-013.1: the chip creates the card at once with labelled rule odds.
    const card = await quickCard();
    expect(card.title).toBe("Water plants");
    expect(card.quote).toMatchObject({
      source: "rule",
      band: 3,
      band_name: "likely",
      odds: 70,
      provisional: true,
      label: "Gemma is thinking · rule odds",
    });
    expect(harness.model.calls.filter((call) => call.job === "listener")).toHaveLength(0);
    expect((await today()).cards.map((c) => c.id)).toEqual([card.id]);

    // AC-006.1: the bet locks what the card showed.
    const bet = await placeBet(card);
    expect(bet).toMatchObject({
      status: "open",
      odds: 70,
      band: 3,
      odds_source: "rule",
      reason: card.quote.reason,
      settle_at: card.quote.settle_at,
    });
    const afterBet = await today();
    expect(afterBet.cards).toEqual([]);
    expect(afterBet.open_bets.map((b) => b.id)).toEqual([bet.id]);
    expect(afterBet.due_bets).toEqual([]);

    // Not yet settle time: the scheduler leaves the bet open and settling is refused.
    harness.clock.advance(HOUR);
    harness.core.scheduler.tick();
    expect((await today()).due_bets).toEqual([]);
    const early = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect(early.statusCode).toBe(409);
    expect(early.headers["content-type"]).toContain("application/problem+json");

    // The scheduler marks the bet due at its settle time.
    reachSettleTime(bet);
    const due = await today();
    expect(due.open_bets).toEqual([]);
    expect(due.due_bets.map((b) => [b.id, b.status])).toEqual([[bet.id, "due"]]);
    expect(due.due_bets[0]?.tap_answers.map((a) => a.id)).toEqual(["moist", "dry", "wilting"]);

    // AC-008.4, AC-009.1: the fake judge says win; a tap pays (100 - 70) x 0.5 = 15.
    const settled = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect(settled.statusCode).toBe(200);
    expect(settled.json()).toMatchObject({
      bet_id: bet.id,
      verdict: "win",
      evidence_kind: "tap",
      multiplier: 0.5,
      points: 15,
      total_points: 15,
    });
    expect(winPoints(70, "tap")).toBe(15);

    const end = await today();
    expect(end).toMatchObject({ due_bets: [], open_bets: [], points: { total: 15 } });
    expect(harness.db.prepare("SELECT status FROM bets").all()).toEqual([{ status: "settled" }]);
  });

  it("AC-009.2: a wrong tap costs the loss points, whatever the odds", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const bet = await placeBet(await quickCard());
    reachSettleTime(bet);
    const settled = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "wilting" });
    expect(settled.json()).toMatchObject({
      verdict: "harmful_loss",
      points: -150,
      total_points: -150,
    });
  });

  it("AC-009.4: the total is the sum of every settled bet's points", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const results: number[] = [];
    for (const answer of ["moist", "dry", "wilting"]) {
      const bet = await placeBet(await quickCard());
      reachSettleTime(bet);
      const settled = await harness.post(`/api/bets/${bet.id}/settle`, { answer });
      results.push(settled.json<{ points: number }>().points);
    }
    expect(results).toEqual([15, -50, -150]);
    expect((await today()).points.total).toBe(15 - 50 - 150);
    const stored = harness.db
      .prepare<[], { total: number }>("SELECT SUM(points) AS total FROM settlements")
      .get();
    expect(stored?.total).toBe(-185);
  });

  it("AC-006.2: a forecast change after the bet leaves the bet unchanged", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const card = await quickCard();
    const bet = await placeBet(card);
    harness.weather.setProfile(FAKE_WEATHER_PROFILES.hot);
    const second = await quickCard();
    expect(second.quote.band).toBe(0);
    expect(second.quote.odds).toBe(15);
    const [open] = (await today()).open_bets;
    expect(open).toMatchObject({ id: bet.id, odds: 70, band: 3, reason: card.quote.reason });
  });

  it("AC-004.2, AC-013.4: a bet on rule odds stores odds_source = rule and the rule band", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.mild });
    const bet = await placeBet(await quickCard());
    const row = harness.db
      .prepare<[number], Record<string, unknown>>("SELECT * FROM bets WHERE id = ?")
      .get(bet.id);
    expect(row).toMatchObject({
      odds_source: "rule",
      rule_band: 1,
      gemma_band: null,
      band: 1,
      odds: 35,
      status: "open",
    });
    expect(Number(row?.["undo_until"]) - Number(row?.["placed_at"])).toBe(5 * MINUTE);
  });

  it("AC-008.8: when Gemma is offline the bet stays due and is never settled by the rule", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const bet = await placeBet(await quickCard());
    reachSettleTime(bet);
    harness.model.setScenario("judge", "offline");
    const failed = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect(failed.statusCode).toBe(503);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 0 });
    expect((await today()).due_bets.map((b) => b.id)).toEqual([bet.id]);

    // The failure is logged for the evaluation; Gemma comes back and the same bet settles.
    expect(
      harness.db.prepare("SELECT job, valid, error FROM gemma_decisions WHERE job = 'judge'").all(),
    ).toEqual([
      { job: "judge", valid: 0, error: expect.stringContaining("unavailable") as unknown },
    ]);
    harness.model.setScenario("judge", "ok");
    const retried = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect(retried.statusCode).toBe(200);
  });

  it.each(["invalid-json", "invalid-schema", "timeout", "unsure"])(
    "a judge answer of kind %s never settles the bet",
    async (scenario) => {
      await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
      const bet = await placeBet(await quickCard());
      reachSettleTime(bet);
      harness.model.setScenario("judge", scenario);
      const response = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
      expect(response.statusCode).toBe(503);
      expect((await today()).points.total).toBe(0);
      expect(harness.db.prepare("SELECT status FROM bets").all()).toEqual([{ status: "due" }]);
    },
  );

  it("logs the judge decision with the bet, prompt version and model", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const bet = await placeBet(await quickCard());
    reachSettleTime(bet);
    await harness.post(`/api/bets/${bet.id}/settle`, { answer: "dry" });
    const decision = harness.db
      .prepare<[], Record<string, unknown>>("SELECT * FROM gemma_decisions WHERE job = 'judge'")
      .get();
    expect(decision).toMatchObject({
      job: "judge",
      bet_id: bet.id,
      model: "fake-gemma",
      prompt_version: "judge.v1",
      valid: 1,
      tool_mode: null,
    });
    const settlement = harness.db
      .prepare<[], Record<string, unknown>>("SELECT * FROM settlements")
      .get();
    expect(settlement).toMatchObject({
      verdict: "normal_loss",
      evidence: "tap",
      multiplier: 0.5,
      points: -50,
      decision_id: decision?.["id"],
      final: 1,
    });
  });

  it("settles a bet only once", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const bet = await placeBet(await quickCard());
    reachSettleTime(bet);
    const first = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    const second = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect([first.statusCode, second.statusCode]).toEqual([200, 409]);
    expect((await today()).points.total).toBe(15);
  });

  it("refuses a second bet on the same card, an unknown card and an out-of-date card", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const card = await quickCard();
    await placeBet(card);
    expect(
      (
        await harness.post("/api/bets", {
          card_id: card.id,
          quote_id: card.quote.id,
          kind: "do_nothing",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await harness.post("/api/bets", { card_id: 999, quote_id: 1, kind: "do_nothing" }))
        .statusCode,
    ).toBe(404);
    const stale = await quickCard();
    harness.clock.current = Date.parse(stale.quote.settle_at) + MINUTE;
    expect(
      (
        await harness.post("/api/bets", {
          card_id: stale.id,
          quote_id: stale.quote.id,
          kind: "do_nothing",
        })
      ).statusCode,
    ).toBe(409);
    expect((await today()).cards).toEqual([]);
  });

  it("answers 400 problem+json to invalid bodies, and 503 when there is no forecast", async () => {
    await setup();
    const invalid = [
      harness.post("/api/cards/quick", { chore_type: "car" }),
      harness.post("/api/cards/quick", {}),
      harness.post("/api/bets", { card_id: 1, quote_id: 1, kind: "skip" }),
      harness.post("/api/bets/1/settle", { answer: "" }),
    ];
    for (const response of await Promise.all(invalid)) {
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    }
    const unknownAnswer = await harness.post("/api/bets/1/settle", { answer: "moist" });
    expect(unknownAnswer.statusCode).toBe(404);

    harness.weather.failWith = new Error("Open-Meteo is down");
    const down = await harness.post("/api/cards/quick", { chore_type: "plants" });
    expect(down.statusCode).toBe(503);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 0 });
  });

  it("rejects an answer that is not one of the chore's taps", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const bet = await placeBet(await quickCard());
    reachSettleTime(bet);
    expect((await harness.post(`/api/bets/${bet.id}/settle`, { answer: "great" })).statusCode).toBe(
      400,
    );
  });

  it("AC-001.3, AC-001.4: the new routes need a session and a same-origin Origin", async () => {
    await setup();
    const noSession = await harness.request({ method: "GET", url: "/api/today" });
    expect(noSession.statusCode).toBe(401);
    expect(noSession.body).not.toContain("flags");
    const noSessionPost = await harness.request({
      method: "POST",
      url: "/api/cards/quick",
      payload: { chore_type: "plants" },
      headers: { origin: `http://${LOCAL_HOST}` },
    });
    expect(noSessionPost.statusCode).toBe(401);
    const noOrigin = await harness.request({
      method: "POST",
      url: "/api/cards/quick",
      payload: { chore_type: "plants" },
      headers: { cookie: harness.cookie },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 0 });
  });

  it("GET /api/cards/:id returns the card with its latest quote, 404 for an unknown card", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const card = await quickCard();
    const fetched = await harness.get(`/api/cards/${card.id}`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(card);
    expect((await harness.get("/api/cards/999")).statusCode).toBe(404);
    expect((await harness.get("/api/cards/abc")).statusCode).toBe(400);
  });

  it("AC-006.1: the bet locks the quote the user saw; a quote that is not the latest is a 409", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const card = await quickCard();
    // A newer quote replaces the one on screen (what Gemma's answer will do in T-006).
    harness.db
      .prepare(
        `INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at)
         VALUES (?, 'gemma', 1, 35, 'Gemma says no', ?, ?)`,
      )
      .run(card.id, Date.parse(card.quote.settle_at), harness.clock.current);
    const stale = await harness.post("/api/bets", {
      card_id: card.id,
      quote_id: card.quote.id,
      kind: "do_nothing",
    });
    expect(stale.statusCode).toBe(409);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 0 });

    const latest = harness.db.prepare<[], { id: number }>("SELECT MAX(id) AS id FROM quotes").get()!
      .id;
    const placed = await harness.post("/api/bets", {
      card_id: card.id,
      quote_id: latest,
      kind: "do_nothing",
    });
    expect(placed.statusCode).toBe(201);
    expect(placed.json()).toMatchObject({ odds: 35, band: 1, odds_source: "gemma" });
    expect(harness.db.prepare("SELECT rule_band, gemma_band FROM bets").get()).toEqual({
      rule_band: 3,
      gemma_band: 1,
    });
  });

  it("requires quote_id to place a bet", async () => {
    await setup();
    const card = await quickCard();
    const response = await harness.post("/api/bets", { card_id: card.id, kind: "do_nothing" });
    expect(response.statusCode).toBe(400);
  });

  it("a tap right after the settle time works without waiting for the scheduler", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const bet = await placeBet(await quickCard());
    harness.clock.current = Date.parse(bet.settle_at); // exactly the settle time, no tick
    const settled = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect(settled.statusCode).toBe(200);
  });

  it("Today lists a bet as due as soon as its settle time has come, without a scheduler pass", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const bet = await placeBet(await quickCard());
    harness.clock.current = Date.parse(bet.settle_at) + 1;
    const view = await today();
    expect(view.open_bets).toEqual([]);
    expect(view.due_bets.map((b) => b.id)).toEqual([bet.id]);
  });

  it("serves API responses with no-store so household data is not cached", async () => {
    await setup();
    expect((await harness.get("/api/today")).headers["cache-control"]).toBe("no-store");
  });
});
