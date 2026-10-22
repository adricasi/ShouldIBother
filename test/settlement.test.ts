import { readdirSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { ANSWER_WINDOW_MS, GEMMA_RETRY_MS } from "../src/domain/settlement.js";
import { LOSS_COPY, PAID_OUT_STAMP } from "../src/domain/settle-copy.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, uploadPhoto, type CoreHarness } from "./core-helpers.js";
import { LOCAL_ORIGIN } from "./helpers.js";
import { multipartBody } from "./support/photos.js";
import { syntheticPhoto } from "./support/photos.js";
import {
  HOUR,
  MINUTE,
  judgeCalls,
  seedBet,
  settlementCount,
  settlementOf,
  statusOf,
  tap,
  type SettleBody,
} from "./support/settle.js";

let harness: CoreHarness;
afterEach(async () => {
  await harness.close();
});

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}): Promise<void> {
  harness = await createCoreHarness(options);
  await pair(harness);
}

async function sendAfterPhoto(betId: number, bytes: Buffer) {
  const body = multipartBody(bytes);
  const response = await harness.request({
    method: "POST",
    url: `/api/bets/${betId}/settle`,
    payload: body.payload,
    headers: { cookie: harness.cookie, origin: LOCAL_ORIGIN, ...body.headers },
  });
  return { status: response.statusCode, body: response.json<SettleBody>() };
}

const photoFiles = (): string[] =>
  readdirSync(harness.photos.dir).filter((name) => name.endsWith(".jpg") || name.endsWith(".tmp"));

const progressOf = (betId: number): Record<string, unknown> | undefined =>
  harness.db
    .prepare<[number], Record<string, unknown>>("SELECT * FROM settle_progress WHERE bet_id = ?")
    .get(betId);

describe("settle by one tap (REQ-008)", () => {
  it("AC-008.1: at the settle time the recorded weather of the bet's window is fetched and shown on the settle screen", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const betId = seedBet(harness, { settleOffsetMs: -MINUTE });
    await harness.core.scheduler.tickSettlement();

    const placed = harness.clock.current - MINUTE - 20 * HOUR;
    expect(harness.weather.recordedRequests).toEqual([
      { fromMs: placed, toMs: harness.clock.current - MINUTE },
    ]);
    const slips = (await harness.get("/api/slips")).json<{
      settle_now: { id: number; settle: { state: string; weather: Record<string, unknown> } }[];
    }>();
    const [due] = slips.settle_now;
    expect(due?.id).toBe(betId);
    expect(due?.settle.state).toBe("answer_needed");
    expect(due?.settle.weather).toMatchObject({
      label: "Modelled recent weather (Open-Meteo)",
      digest: { rain_mm: 3, wet_hours: 6 },
    });
    // The same snapshot is what the judge reads and what the settlement keeps (below).
    expect(harness.weather.recordedRequests).toHaveLength(1);
  });

  it("AC-008.1: when the recorded weather is not there yet the bet waits and the answer is saved", async () => {
    await setup();
    harness.weather.recordedAvailable = false;
    const betId = seedBet(harness);
    const waiting = await tap(harness, betId, "moist");
    expect(waiting).toMatchObject({ status: 202, body: { state: "awaiting_weather" } });
    expect(statusOf(harness, betId)).toBe("awaiting_weather");
    expect(progressOf(betId)).toMatchObject({ evidence: "tap", answer_id: "moist" });
    expect(judgeCalls(harness)).toHaveLength(0);
    expect(settlementCount(harness)).toBe(0);
  });

  it("AC-014.5, AC-008.8: the weather step releases the bet every 30 minutes and the saved answer is then judged", async () => {
    await setup();
    harness.weather.recordedAvailable = false;
    const betId = seedBet(harness);
    await tap(harness, betId, "moist");
    harness.weather.recordedAvailable = true;
    harness.clock.advance(31 * MINUTE);
    expect(await harness.core.scheduler.tickWeather()).toBe(1);
    expect(statusOf(harness, betId)).toBe("awaiting_gemma");
    expect(await harness.core.scheduler.tickSettlement()).toBe(1);
    expect(settlementOf(harness, betId)).toMatchObject({ evidence: "tap", points: 15 });
  });

  it("AC-008.3, AC-008.4: a tap goes to the judge with the recorded weather; the verdict, reason and evidence come back and the bet is settled", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const betId = seedBet(harness, { band: 3 });
    const { status, body } = await tap(harness, betId, "moist");
    expect(status).toBe(200);
    expect(body.state).toBe("settled");
    expect(body.receipt).toMatchObject({
      verdict: "win",
      points: 15,
      multiplier: 0.5,
      evidence: { kind: "tap" },
      answer: "Still moist, all fine",
      gemma_read: {
        reason: "The soil is still moist, so skipping the watering worked.",
        evidence: ["Tapped: still moist"],
      },
    });
    const [call] = judgeCalls(harness);
    expect(call?.data).toMatchObject({
      bet: "do_nothing",
      evidence: "one tap",
      person_answered: "Still moist, all fine",
      recorded_weather: { label: "Modelled recent weather (Open-Meteo)", rain_mm: 3 },
    });
    expect(call?.images).toBe(0);
    expect(statusOf(harness, betId)).toBe("settled");
    const stored = settlementOf(harness, betId);
    expect(stored).toMatchObject({ evidence: "tap", multiplier: 0.5, points: 15, final: 1 });
    expect(JSON.parse(stored["weather"] as string)).toMatchObject({
      label: "Modelled recent weather (Open-Meteo)",
      digest: { rain_mm: 3 },
    });
  });

  it("refuses a tap before the settle time, an unknown answer, a do-it decision and a second answer", async () => {
    await setup();
    const early = seedBet(harness, { settleOffsetMs: HOUR, status: "open" });
    expect((await tap(harness, early, "moist")).status).toBe(409);
    const due = seedBet(harness);
    expect((await tap(harness, due, "great")).status).toBe(400);
    expect((await tap(harness, 999, "moist")).status).toBe(404);
    const doIt = seedBet(harness, { kind: "do_it" });
    expect((await tap(harness, doIt, "moist")).status).toBe(409);
    expect((await tap(harness, due, "moist")).status).toBe(200);
    expect((await tap(harness, due, "dry")).status).toBe(409);
    expect(judgeCalls(harness)).toHaveLength(1);
  });

  it("settles a bet only once when two answers arrive together", async () => {
    await setup();
    const betId = seedBet(harness);
    const [first, second] = await Promise.all([
      tap(harness, betId, "moist"),
      tap(harness, betId, "moist"),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(settlementCount(harness)).toBe(1);
  });
});

describe("settle by after photo (AC-008.2)", () => {
  it("strips and resizes the after photo, sends it with the before photo and the weather, and pays in full", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    // A card with a before photo, then a bet on it.
    const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
    }>();
    expect((await uploadPhoto(harness, card.id, await syntheticPhoto())).statusCode).toBe(201);
    await harness.idle();
    const quote = (await harness.get(`/api/cards/${card.id}`)).json<{ quote: { id: number } }>();
    const placed = await harness.post("/api/bets", {
      card_id: card.id,
      quote_id: quote.quote.id,
      kind: "do_nothing",
    });
    const betId = placed.json<{ id: number; odds: number }>().id;
    const odds = placed.json<{ odds: number }>().odds;
    const settleAt = harness.db
      .prepare<[number], { settle_at: number }>("SELECT settle_at FROM bets WHERE id = ?")
      .get(betId)!.settle_at;
    harness.clock.current = settleAt + MINUTE;

    const big = await syntheticPhoto({
      width: 2400,
      height: 1600,
      orientation: 6,
      withMetadata: true,
    });
    const { status, body } = await sendAfterPhoto(betId, big);
    expect(status).toBe(200);
    expect(body.receipt).toMatchObject({
      verdict: "win",
      multiplier: 1,
      points: 100 - odds,
      evidence: { kind: "photo" },
    });

    const [call] = judgeCalls(harness);
    expect(call?.images).toBe(2);
    expect(call?.data).toMatchObject({ evidence: "after photo", photos: ["before", "after"] });
    expect(call?.data["recorded_weather"]).not.toBeNull();

    const row = harness.db
      .prepare<[number], { file: string; width: number; height: number }>(
        "SELECT file, width, height FROM photos WHERE bet_id = ? AND role = 'after'",
      )
      .get(betId)!;
    expect(Math.max(row.width, row.height)).toBe(1024);
    const metadata = await sharp(harness.photos.read(row.file)).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    // The judge decision carries the after photo, so deleting the photo deletes the decision.
    expect(
      harness.db.prepare("SELECT photo_id FROM gemma_decisions WHERE job = 'judge'").all(),
    ).toEqual([{ photo_id: expect.any(String) as unknown }]);
    expect(progressOf(betId)).toMatchObject({ evidence: "photo" });
  });

  it("sends only the after photo when the card has no before photo", async () => {
    await setup();
    const betId = seedBet(harness);
    const { status } = await sendAfterPhoto(betId, await syntheticPhoto());
    expect(status).toBe(200);
    const [call] = judgeCalls(harness);
    expect(call?.images).toBe(1);
    expect(call?.data).toMatchObject({ photos: ["after"] });
  });

  it("answers 415 for a file that is not an image and leaves the bet, files and rows as they were", async () => {
    await setup();
    const betId = seedBet(harness);
    const { status } = await sendAfterPhoto(betId, Buffer.from("not an image at all"));
    expect(status).toBe(415);
    expect(statusOf(harness, betId)).toBe("due");
    expect(progressOf(betId)?.["evidence"] ?? null).toBeNull();
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM photos").get()).toEqual({ n: 0 });
    expect(photoFiles()).toEqual([]);
    expect(judgeCalls(harness)).toHaveLength(0);
  });
});

describe("the judge is unsure (AC-008.5)", () => {
  it("AC-008.5: stores and returns the yes/no question, then re-judges with the answer", async () => {
    await setup();
    const betId = seedBet(harness);
    harness.model.setScenario("judge", "unsure");
    const asked = await tap(harness, betId, "moist");
    expect(asked).toMatchObject({
      status: 200,
      body: { state: "question", question: "Did it rain on the balcony overnight?" },
    });
    expect(statusOf(harness, betId)).toBe("due");
    expect(progressOf(betId)).toMatchObject({
      question: "Did it rain on the balcony overnight?",
      evidence: "tap",
    });
    const slips = (await harness.get("/api/slips")).json<{
      settle_now: { settle: { state: string; question: string } }[];
    }>();
    expect(slips.settle_now[0]?.settle).toMatchObject({
      state: "question",
      question: "Did it rain on the balcony overnight?",
    });

    harness.model.setScenario("judge", "ok");
    const answered = await harness.post(`/api/bets/${betId}/answer`, { yes: true });
    expect(answered.json<SettleBody>().state).toBe("settled");
    const second = judgeCalls(harness)[1];
    expect(second?.data["earlier_questions"]).toEqual([
      { question: "Did it rain on the balcony overnight?", answer: "yes" },
    ]);
    expect(second?.data["person_answered"]).toBe("Still moist, all fine");
    // Nothing to answer once settled.
    expect((await harness.post(`/api/bets/${betId}/answer`, { yes: true })).statusCode).toBe(409);
  });

  it("AC-008.5: after two questions the judge has to decide: a third 'unsure' never settles the bet", async () => {
    await setup();
    const betId = seedBet(harness);
    harness.model.setScenario("judge", "unsure");
    expect((await tap(harness, betId, "moist")).body.state).toBe("question");
    const second = await harness.post(`/api/bets/${betId}/answer`, { yes: false });
    expect(second.json<SettleBody>().state).toBe("question");
    const third = await harness.post(`/api/bets/${betId}/answer`, { yes: true });
    expect(third.statusCode).toBe(202);
    expect(third.json<SettleBody>().state).toBe("awaiting_gemma");
    const last = judgeCalls(harness).at(-1);
    expect(last?.data["can_ask"]).toBe(false);
    expect(settlementCount(harness)).toBe(0);
    expect(statusOf(harness, betId)).toBe("awaiting_gemma");
  });

  it("answers 409 when the judge asked nothing", async () => {
    await setup();
    const betId = seedBet(harness);
    expect((await harness.post(`/api/bets/${betId}/answer`, { yes: true })).statusCode).toBe(409);
  });
});

describe("lucky win (AC-008.6)", () => {
  it("AC-008.6: a win when the recorded weather does not meet the label is a lucky win, paid as a win", async () => {
    // Hot and dry: ET0 over the window is far above 1 mm, so the pots needed water.
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.hot });
    const betId = seedBet(harness, { band: 3 });
    const { body } = await tap(harness, betId, "moist");
    expect(body.receipt).toMatchObject({
      verdict: "win",
      points: 15,
      outcome: "paid_out",
      lucky_win: true,
    });
    expect(settlementOf(harness, betId)).toMatchObject({ verdict: "win", lucky_win: 1 });
  });

  it("AC-008.6: a win the weather delivered is not lucky; the code, not the judge, decides", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const betId = seedBet(harness, { band: 3 });
    const { body } = await tap(harness, betId, "moist");
    expect(body.receipt?.lucky_win).toBe(false);
    expect(settlementOf(harness, betId)["lucky_win"]).toBe(0);
    // The judge's output has no field for it.
    expect(JSON.stringify(judgeCalls(harness)[0]?.data)).not.toContain("lucky");
  });

  it("AC-008.6: a loss and a do-it result carry no lucky-win flag", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.hot });
    const loss = seedBet(harness);
    await tap(harness, loss, "dry");
    expect(settlementOf(harness, loss)["lucky_win"]).toBeNull();
  });
});

describe("no answer for 24 hours (AC-008.7)", () => {
  it("AC-008.7: the judge settles from the recorded weather alone at x0.5, 24 h after the settle time", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const betId = seedBet(harness, { band: 3 });
    harness.clock.advance(ANSWER_WINDOW_MS - MINUTE - 1000);
    await harness.core.scheduler.tickSettlement();
    expect(judgeCalls(harness)).toHaveLength(0);
    expect(statusOf(harness, betId)).toBe("due");

    harness.clock.advance(2000); // settle time + 24 h
    expect(await harness.core.scheduler.tickSettlement()).toBe(1);
    const [call] = judgeCalls(harness);
    expect(call?.data).toMatchObject({ evidence: "weather record only", can_ask: false });
    expect(call?.images).toBe(0);
    expect(settlementOf(harness, betId)).toMatchObject({
      evidence: "auto",
      multiplier: 0.5,
      verdict: "win",
      points: 15,
    });
  });

  it("AC-008.7: an answer after the 24 h is refused; the bet settles on its own", async () => {
    await setup();
    const betId = seedBet(harness, { settleOffsetMs: -ANSWER_WINDOW_MS - MINUTE });
    expect((await tap(harness, betId, "moist")).status).toBe(409);
    expect(await harness.core.scheduler.tickSettlement()).toBe(1);
    expect(settlementOf(harness, betId)).toMatchObject({ evidence: "auto", multiplier: 0.5 });
  });
});

describe("Gemma offline (AC-008.8)", () => {
  it("AC-008.8: an offline judge never lets the rule settle the bet; the answer is kept and the scheduler judges it when Gemma is back", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const betId = seedBet(harness, { band: 3 });
    harness.model.setScenario("judge", "offline");
    const waiting = await tap(harness, betId, "moist");
    expect(waiting).toMatchObject({ status: 202, body: { state: "awaiting_gemma" } });
    expect(statusOf(harness, betId)).toBe("awaiting_gemma");
    expect(settlementCount(harness)).toBe(0);
    expect(progressOf(betId)).toMatchObject({
      evidence: "tap",
      answer_id: "moist",
      failure: "unavailable",
    });
    // The failed try is logged for the evaluation.
    expect(
      harness.db.prepare("SELECT job, valid FROM gemma_decisions WHERE job = 'judge'").all(),
    ).toEqual([{ job: "judge", valid: 0 }]);
    const slips = (await harness.get("/api/slips")).json<{
      settle_now: { status: string; settle: { state: string; note: string } }[];
    }>();
    expect(slips.settle_now[0]).toMatchObject({
      status: "awaiting_gemma",
      settle: { state: "waiting_gemma", note: expect.stringContaining("Gemma is back") as unknown },
    });

    // Passes while Gemma is still down, even days later, settle nothing.
    harness.clock.advance(GEMMA_RETRY_MS);
    expect(await harness.core.scheduler.tickSettlement()).toBe(0);
    harness.clock.advance(3 * ANSWER_WINDOW_MS);
    expect(await harness.core.scheduler.tickSettlement()).toBe(0);
    expect(settlementCount(harness)).toBe(0);

    // Gemma returns: the saved answer is judged, at the multiplier of the answer (it was given in time).
    harness.model.setScenario("judge", "ok");
    harness.clock.advance(GEMMA_RETRY_MS);
    expect(await harness.core.scheduler.tickSettlement()).toBe(1);
    expect(settlementOf(harness, betId)).toMatchObject({
      evidence: "tap",
      multiplier: 0.5,
      points: 15,
    });
  });

  it("AC-008.8: the scheduler waits two minutes between tries on the same bet", async () => {
    await setup();
    const betId = seedBet(harness);
    harness.model.setScenario("judge", "offline");
    await tap(harness, betId, "moist");
    const calls = (): number => judgeCalls(harness).length;
    const before = calls();
    harness.clock.advance(GEMMA_RETRY_MS - 1000);
    await harness.core.scheduler.tickSettlement();
    expect(calls()).toBe(before);
    harness.clock.advance(2000);
    await harness.core.scheduler.tickSettlement();
    expect(calls()).toBe(before + 1);
    expect(statusOf(harness, betId)).toBe("awaiting_gemma");
  });

  it("AC-008.8: an unanswered bet 24 h late with Gemma offline stays unsettled; a photo answer given in time keeps x1.0 when Gemma returns late", async () => {
    await setup();
    const waiting = seedBet(harness, { settleOffsetMs: -ANSWER_WINDOW_MS - MINUTE });
    const answered = seedBet(harness, { band: 3 });
    harness.model.setScenario("judge", "offline");
    expect((await sendAfterPhoto(answered, await syntheticPhoto())).status).toBe(202);
    expect(await harness.core.scheduler.tickSettlement()).toBe(0);
    expect(statusOf(harness, waiting)).toBe("awaiting_gemma");
    expect(settlementCount(harness)).toBe(0);

    harness.model.setScenario("judge", "ok");
    harness.clock.advance(2 * ANSWER_WINDOW_MS);
    expect(await harness.core.scheduler.tickSettlement()).toBe(2);
    expect(settlementOf(harness, waiting)).toMatchObject({ evidence: "auto", multiplier: 0.5 });
    expect(settlementOf(harness, answered)).toMatchObject({ evidence: "photo", multiplier: 1 });
  });

  it.each(["invalid-json", "invalid-schema", "timeout", "wrong-kind"])(
    "AC-008.8: a judge answer of kind %s never settles the bet",
    async (scenario) => {
      await setup();
      const betId = seedBet(harness);
      harness.model.setScenario("judge", scenario);
      const response = await tap(harness, betId, "moist");
      expect(response).toMatchObject({ status: 202, body: { state: "awaiting_gemma" } });
      expect(settlementCount(harness)).toBe(0);
      expect(statusOf(harness, betId)).toBe("awaiting_gemma");
    },
  );

  it("an unexpected error in the model client becomes awaiting_gemma, never a 500", async () => {
    await setup();
    const betId = seedBet(harness);
    const original = harness.model.chat.bind(harness.model);
    harness.model.chat = (request) => {
      if (request.job === "judge") {
        return Promise.reject(new TypeError("boom"));
      }
      return original(request);
    };
    const response = await tap(harness, betId, "moist");
    expect(response).toMatchObject({ status: 202, body: { state: "awaiting_gemma" } });
    expect(progressOf(betId)).toMatchObject({ failure: "internal" });
    expect(settlementCount(harness)).toBe(0);
  });

  it("answers 503 'Gemma is busy' before any state change when the job queue is full", async () => {
    await setup({ runner: { maxQueued: 0 } });
    const betId = seedBet(harness);
    const response = await harness.post(`/api/bets/${betId}/settle`, { answer: "moist" });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ title: string }>().title).toBe("Gemma is busy");
    expect(progressOf(betId)).toBeUndefined();
    expect(statusOf(harness, betId)).toBe("due");
  });
});

describe("do-it decisions (AC-008.9)", () => {
  it("AC-008.9, AC-009.3: at the settle time the judge decides from the recorded weather: +5 when it would not have helped", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.mild });
    const betId = seedBet(harness, { kind: "do_it" });
    expect(await harness.core.scheduler.tickSettlement()).toBe(1);
    const [call] = judgeCalls(harness);
    expect(call?.data).toMatchObject({
      bet: "do_it",
      evidence: "weather record only",
      can_ask: false,
    });
    expect(settlementOf(harness, betId)).toMatchObject({
      verdict: "weather_would_not",
      points: 5,
      evidence: "auto",
      lucky_win: null,
    });
  });

  it("AC-009.3: -10 when the weather would have done the chore", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const betId = seedBet(harness, { kind: "do_it" });
    await harness.core.scheduler.tickSettlement();
    expect(settlementOf(harness, betId)).toMatchObject({
      verdict: "weather_would_have",
      points: -10,
    });
    const receipt = (await harness.get(`/api/bets/${betId}/receipt`)).json<
      NonNullable<SettleBody["receipt"]>
    >();
    expect(receipt).toMatchObject({ outcome: "do_it", stamp: null, saved: null });
    expect(receipt.message).toBe(LOSS_COPY.weather_would_have);
  });

  it("AC-008.9, AC-008.8: with Gemma offline a do-it decision waits, then settles when Gemma is back", async () => {
    await setup();
    const betId = seedBet(harness, { kind: "do_it" });
    harness.model.setScenario("judge", "offline");
    await harness.core.scheduler.tickSettlement();
    expect(statusOf(harness, betId)).toBe("awaiting_gemma");
    harness.model.setScenario("judge", "do-it-would-not");
    harness.clock.advance(GEMMA_RETRY_MS);
    expect(await harness.core.scheduler.tickSettlement()).toBe(1);
    expect(settlementOf(harness, betId)["points"]).toBe(5);
  });

  it("AC-008.9: a bet-on-doing-nothing verdict for a do-it decision is rejected", async () => {
    await setup();
    const betId = seedBet(harness, { kind: "do_it" });
    harness.model.setScenario("judge", "ok"); // a "win" verdict
    await harness.core.scheduler.tickSettlement();
    expect(settlementCount(harness)).toBe(0);
    expect(statusOf(harness, betId)).toBe("awaiting_gemma");
  });
});

describe("points (REQ-009)", () => {
  it.each([
    { band: 4, answer: "moist", points: 8 }, // 15 x 0.5 = 7.5 -> 8, halves up
    { band: 3, answer: "moist", points: 15 },
    { band: 2, answer: "moist", points: 25 },
    { band: 1, answer: "moist", points: 33 }, // 65 x 0.5 = 32.5 -> 33
    { band: 0, answer: "moist", points: 43 }, // 85 x 0.5 = 42.5 -> 43
  ])("AC-009.1: a tap win at band $band pays $points", async ({ band, answer, points }) => {
    await setup();
    const betId = seedBet(harness, { band: band as 0 | 1 | 2 | 3 | 4 });
    const { body } = await tap(harness, betId, answer);
    expect(body.receipt?.points).toBe(points);
  });

  it.each([
    { band: 4, points: 15 },
    { band: 1, points: 65 },
    { band: 0, points: 85 },
  ])("AC-009.1: a photo win at band $band pays $points (x1.0)", async ({ band, points }) => {
    await setup();
    const betId = seedBet(harness, { band: band as 0 | 1 | 4 });
    const { body } = await sendAfterPhoto(betId, await syntheticPhoto());
    expect(body.receipt?.points).toBe(points);
  });

  it.each([
    { answer: "dry", points: -50 },
    { answer: "wilting", points: -150 },
  ])("AC-009.2: $answer costs $points by tap and by photo", async ({ answer, points }) => {
    await setup();
    const byTap = seedBet(harness, { band: 0 });
    expect((await tap(harness, byTap, answer)).body.receipt?.points).toBe(points);
    const byPhoto = seedBet(harness, { band: 4 });
    harness.model.setScenario("judge", answer === "dry" ? "normal-loss" : "harmful-loss");
    expect((await sendAfterPhoto(byPhoto, await syntheticPhoto())).body.receipt?.points).toBe(
      points,
    );
  });

  it("AC-009.2: a small loss is -25", async () => {
    await setup();
    const betId = seedBet(harness, { chore: "laundry_line" });
    expect((await tap(harness, betId, "line_damp")).body.receipt).toMatchObject({
      verdict: "small_loss",
      points: -25,
    });
  });

  it("AC-009.4: the points total equals the sum of each settled bet's points", async () => {
    await setup();
    const bets = [
      seedBet(harness, { band: 3 }),
      seedBet(harness, { band: 1 }),
      seedBet(harness, { band: 2 }),
    ];
    const answers = ["moist", "wilting", "dry"];
    for (const [index, betId] of bets.entries()) {
      await tap(harness, betId, answers[index]!);
    }
    const doIt = seedBet(harness, { kind: "do_it" });
    await harness.core.scheduler.tickSettlement();
    const total = (await harness.get("/api/today")).json<{ points: { total: number } }>().points
      .total;
    const sum = harness.db
      .prepare<[], { sum: number }>("SELECT SUM(points) AS sum FROM settlements WHERE final = 1")
      .get()!.sum;
    expect(total).toBe(sum);
    expect(total).toBe(15 - 150 - 50 + 5);
    expect(settlementOf(harness, doIt)["points"]).toBe(5);
  });
});

describe("receipt and loss screen (REQ-010, AC-028.1)", () => {
  it("AC-010.1, AC-028.1: a win prints the PAID OUT receipt with bet, odds, evidence, weather, points, time and water saved", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const betId = seedBet(harness, { band: 3 });
    const { body } = await tap(harness, betId, "moist");
    expect(body.receipt).toMatchObject({
      bet_id: betId,
      title: "Water plants",
      kind: "do_nothing",
      outcome: "paid_out",
      stamp: PAID_OUT_STAMP,
      odds: 70,
      points: 15,
      evidence: { kind: "tap", text: "One tap, paid at half" },
      weather: {
        label: "Modelled recent weather (Open-Meteo)",
        digest: { rain_mm: 3, hours: 21 },
      },
      gemma_read: { evidence: ["Tapped: still moist"] },
      saved: {
        time_min: 5,
        water_l: 4,
        electricity_kwh: 0,
        assumption: expect.stringContaining("balcony pots") as unknown,
        basis: "typical estimate",
      },
      message: null,
    });
    const again = (await harness.get(`/api/bets/${betId}/receipt`)).json<unknown>();
    expect(again).toEqual(body.receipt);
    // The same receipt is on Slips, under Settled.
    const slips = (await harness.get("/api/slips")).json<{
      settled: { id: number; receipt: { stamp: string } }[];
    }>();
    expect(slips.settled[0]).toMatchObject({ id: betId, receipt: { stamp: PAID_OUT_STAMP } });
  });

  it.each([
    ["dry", "normal_loss"],
    ["wilting", "harmful_loss"],
  ] as const)(
    "AC-010.2: a loss (%s) shows the result with points and reason, the fixed copy and no stamp",
    async (answer, verdict) => {
      await setup();
      const betId = seedBet(harness);
      const { body } = await tap(harness, betId, answer);
      expect(body.receipt).toMatchObject({
        outcome: "loss",
        stamp: null,
        verdict,
        message: LOSS_COPY[verdict],
        saved: null,
        gemma_read: { reason: expect.any(String) as unknown },
      });
      expect(body.receipt?.points).toBeLessThan(0);
    },
  );

  it("AC-010.2: the fixed loss strings do not shame", () => {
    for (const text of Object.values(LOSS_COPY)) {
      expect(text).not.toMatch(/fail|stupid|lazy|bad|wrong|should have|blame|your fault/i);
      expect(text.length).toBeLessThan(140);
    }
  });

  it("AC-015.2: deleting the after photo deletes the judge's decision; the verdict and points stay", async () => {
    await setup();
    const betId = seedBet(harness, { band: 3 });
    expect((await sendAfterPhoto(betId, await syntheticPhoto())).status).toBe(200);
    const photo = harness.db
      .prepare<[number], { id: string; file: string }>(
        "SELECT id, file FROM photos WHERE bet_id = ?",
      )
      .get(betId)!;
    expect((await harness.delete(`/api/photos/${photo.id}`)).statusCode).toBe(204);
    expect(
      harness.db.prepare("SELECT COUNT(*) AS n FROM gemma_decisions WHERE job = 'judge'").get(),
    ).toEqual({ n: 0 });
    expect(photoFiles()).toEqual([]);
    const receipt = (await harness.get(`/api/bets/${betId}/receipt`)).json<
      NonNullable<SettleBody["receipt"]>
    >();
    expect(receipt).toMatchObject({ verdict: "win", points: 30, gemma_read: null });
  });

  it("AC-015.2: deleting the before photo also deletes the judge decisions that read it", async () => {
    await setup();
    const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
    }>();
    await uploadPhoto(harness, card.id, await syntheticPhoto());
    await harness.idle();
    const quote = (await harness.get(`/api/cards/${card.id}`)).json<{ quote: { id: number } }>();
    const betId = (
      await harness.post("/api/bets", {
        card_id: card.id,
        quote_id: quote.quote.id,
        kind: "do_nothing",
      })
    ).json<{ id: number }>().id;
    harness.db.prepare("UPDATE bets SET status = 'due' WHERE id = ?").run(betId);
    harness.clock.current =
      harness.db
        .prepare<[number], { settle_at: number }>("SELECT settle_at FROM bets WHERE id = ?")
        .get(betId)!.settle_at + HOUR;
    expect((await sendAfterPhoto(betId, await syntheticPhoto())).status).toBe(200);
    const before = harness.db
      .prepare<[number], { id: string }>(
        "SELECT id FROM photos WHERE card_id = ? AND role = 'before'",
      )
      .get(card.id)!;
    await harness.delete(`/api/photos/${before.id}`);
    expect(
      harness.db.prepare("SELECT COUNT(*) AS n FROM gemma_decisions WHERE job = 'judge'").get(),
    ).toEqual({ n: 0 });
    expect(settlementCount(harness)).toBe(1);
  });
});
