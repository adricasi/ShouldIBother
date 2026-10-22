import { afterEach, describe, expect, it } from "vitest";

import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let harness: CoreHarness;
afterEach(async () => {
  await harness.close();
});

async function setup(): Promise<CoreHarness> {
  harness = await createCoreHarness({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
  await pair(harness);
  return harness;
}

interface SlipBet {
  id: number;
  kind: string;
  status: string;
  settle_at: string;
  time_left_ms?: number;
  tap_answers: { id: string }[];
  result?: { verdict: string; points: number; evidence: string };
}
interface Slips {
  now: string;
  settle_now: SlipBet[];
  waiting: SlipBet[];
  settled: SlipBet[];
}

async function slips(): Promise<Slips> {
  const response = await harness.get("/api/slips");
  expect(response.statusCode).toBe(200);
  return response.json<Slips>();
}

async function placeOn(cardId: number, kind: "do_nothing" | "do_it" = "do_nothing") {
  const response = await harness.post("/api/bets", { card_id: cardId, kind });
  expect(response.statusCode).toBe(201);
  return response.json<SlipBet>();
}

async function freshBet(kind: "do_nothing" | "do_it" = "do_nothing"): Promise<SlipBet> {
  const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
    id: number;
  }>();
  return placeOn(card.id, kind);
}

describe("REQ-007: Slips with countdown", () => {
  it("AC-007.3: with no bets all three groups are empty", async () => {
    await setup();
    expect(await slips()).toMatchObject({ settle_now: [], waiting: [], settled: [] });
  });

  it("AC-007.1: lists Waiting with time left, Settle now, and Settled with result and points", async () => {
    await setup();
    const settledBet = await freshBet();
    const doIt = await freshBet("do_it");
    // Make the first bet due and settle it, then wait for the settle time of the others to pass.
    harness.clock.current = Date.parse(settledBet.settle_at) + MINUTE;
    harness.core.scheduler.tick();
    await harness.post(`/api/bets/${settledBet.id}/settle`, { answer: "moist" });
    // A third bet placed now is still waiting.
    const waitingBet = await freshBet();

    const result = await slips();
    expect(result.now).toBe(new Date(harness.clock.now()).toISOString());
    expect(result.settle_now.map((b) => [b.id, b.kind])).toEqual([[doIt.id, "do_it"]]);
    expect(result.waiting.map((b) => b.id)).toEqual([waitingBet.id]);
    expect(result.waiting[0]?.time_left_ms).toBe(
      Date.parse(waitingBet.settle_at) - harness.clock.now(),
    );
    expect(result.settled.map((b) => b.id)).toEqual([settledBet.id]);
    expect(result.settled[0]?.result).toMatchObject({
      verdict: "win",
      points: 15,
      evidence: "tap",
    });
  });

  it("AC-007.2: a bet whose settle time has passed is under Settle now at read time, before the scheduler runs", async () => {
    await setup();
    const bet = await freshBet();
    expect((await slips()).waiting.map((b) => b.id)).toEqual([bet.id]);

    // One millisecond before the settle time: still waiting.
    harness.clock.current = Date.parse(bet.settle_at) - 1;
    expect((await slips()).waiting.map((b) => b.id)).toEqual([bet.id]);

    // At the settle time (at or before the current time): Settle now. No scheduler tick happened.
    harness.clock.current = Date.parse(bet.settle_at);
    const result = await slips();
    expect(result.waiting).toEqual([]);
    expect(result.settle_now.map((b) => [b.id, b.status])).toEqual([[bet.id, "open"]]);
    expect(result.settle_now[0]?.tap_answers.map((a) => a.id)).toEqual(["moist", "dry", "wilting"]);
  });

  it("AC-007.2: a bet listed under Settle now before the scheduler ticked can be settled", async () => {
    await setup();
    const bet = await freshBet();
    harness.clock.current = Date.parse(bet.settle_at) + HOUR;
    expect((await slips()).settle_now).toHaveLength(1);
    const settled = await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect(settled.statusCode).toBe(200);
    expect((await slips()).settled.map((b) => b.id)).toEqual([bet.id]);
  });

  it("AC-007.2: bets waiting for Gemma stay under Settle now with their status", async () => {
    await setup();
    const bet = await freshBet();
    harness.clock.current = Date.parse(bet.settle_at) + MINUTE;
    harness.core.scheduler.tick();
    harness.db.prepare("UPDATE bets SET status = 'awaiting_gemma' WHERE id = ?").run(bet.id);
    expect((await slips()).settle_now.map((b) => [b.id, b.status])).toEqual([
      [bet.id, "awaiting_gemma"],
    ]);
  });

  it("AC-007.1: orders Waiting by settle time, Settled newest first, and leaves out undone bets", async () => {
    await setup();
    const undone = await freshBet();
    await harness.delete(`/api/bets/${undone.id}`);
    const first = await freshBet();
    harness.clock.advance(HOUR);
    const second = await freshBet();
    expect((await slips()).waiting.map((b) => b.id)).toEqual([first.id, second.id]);

    for (const bet of [first, second]) {
      harness.clock.current = Date.parse(bet.settle_at) + MINUTE;
      harness.core.scheduler.tick();
      await harness.post(`/api/bets/${bet.id}/settle`, { answer: "dry" });
    }
    const result = await slips();
    expect(result.settled.map((b) => b.id)).toEqual([second.id, first.id]);
    expect(result.settled.every((b) => b.result?.points === -50)).toBe(true);
    expect([...result.waiting, ...result.settle_now].map((b) => b.id)).not.toContain(undone.id);
  });

  it("needs a session and sets no-store", async () => {
    await setup();
    const anonymous = await harness.request({ method: "GET", url: "/api/slips" });
    expect(anonymous.statusCode).toBe(401);
    expect((await harness.get("/api/slips")).headers["cache-control"]).toBe("no-store");
  });
});
