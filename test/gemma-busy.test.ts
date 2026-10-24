import { afterEach, describe, expect, it, vi } from "vitest";

import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, uploadPhoto, type CoreHarness } from "./core-helpers.js";
import { HOUR, seedBet } from "./support/settle.js";
import { syntheticPhoto } from "./support/photos.js";

let harness: CoreHarness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = undefined;
});

interface CardJson {
  id: number;
  quote: { source: string; label: string } | null;
  gemma: { state: string; note: string | null; can_retry: boolean } | null;
}

async function setup(): Promise<CoreHarness> {
  harness = await createCoreHarness({ weatherProfile: FAKE_WEATHER_PROFILES.mild });
  await pair(harness);
  harness.clock.current = Date.UTC(2026, 9, 22, 8, 0);
  return harness;
}

/** The queue holds 8 jobs already: a new one is refused, and no flow of several fits. */
function fillQueue(h: CoreHarness): void {
  vi.spyOn(h.core.gemma, "full", "get").mockReturnValue(true);
  vi.spyOn(h.core.gemma, "hasRoom").mockReturnValue(false);
}

const count = (h: CoreHarness, table: string): number =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("AC-013.6: 8 Gemma jobs queued or running refuse work that needs Gemma, before any state changes", () => {
  it("refuses listener capture with 503 'Gemma is busy' and makes no card", async () => {
    const h = await setup();
    fillQueue(h);
    const response = await h.post("/api/cards", { text: "water the plants" });
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json<{ title: string }>().title).toBe("Gemma is busy");
    expect(count(h, "cards")).toBe(0);
  });

  it("refuses Retry with 503 and leaves the card as it was", async () => {
    const h = await setup();
    const card = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<CardJson>();
    await h.idle();
    const before = h.db.prepare("SELECT * FROM cards WHERE id = ?").get(card.id);
    fillQueue(h);
    expect((await h.post(`/api/cards/${card.id}/retry`, {})).statusCode).toBe(503);
    expect(h.db.prepare("SELECT * FROM cards WHERE id = ?").get(card.id)).toEqual(before);
  });

  it("refuses an answer to Gemma's question with 503 and stores no answer", async () => {
    const h = await setup();
    h.model.setScenario("bookmaker", "unsure");
    const card = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<CardJson>();
    await h.idle();
    expect(
      ((await h.get(`/api/cards/${card.id}`)).json<CardJson>().gemma ?? { state: "" }).state,
    ).toBe("question");
    fillQueue(h);
    const response = await h.post(`/api/cards/${card.id}/answer`, { yes: true });
    expect(response.statusCode).toBe(503);
    expect(h.db.prepare("SELECT gemma_answers AS a FROM cards WHERE id = ?").get(card.id)).toEqual({
      a: "[]",
    });
    expect((await h.get(`/api/cards/${card.id}`)).json<CardJson>().gemma?.state).toBe("question");
  });

  it("refuses a settle answer with 503, writes no progress and keeps the bet due", async () => {
    const h = await setup();
    const betId = seedBet(h);
    fillQueue(h);
    const response = await h.post(`/api/bets/${betId}/settle`, { answer: "moist" });
    expect(response.statusCode).toBe(503);
    expect(count(h, "settle_progress")).toBe(0);
    expect(count(h, "settlements")).toBe(0);
    expect(h.db.prepare("SELECT status FROM bets WHERE id = ?").get(betId)).toEqual({
      status: "due",
    });
  });

  it("refuses a photo upload with 503 and stores nothing", async () => {
    const h = await setup();
    const card = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<CardJson>();
    await h.idle();
    fillQueue(h);
    const response = await uploadPhoto(h, card.id, await syntheticPhoto());
    expect(response.statusCode).toBe(503);
    expect(count(h, "photos")).toBe(0);
  });

  it("still makes a quick-chip card, with its rule odds, 'Gemma offline · rule odds' and the busy note", async () => {
    const h = await setup();
    fillQueue(h);
    const response = await h.post("/api/cards/quick", { chore_type: "plants" });
    expect(response.statusCode).toBe(201);
    const card = response.json<CardJson>();
    expect(card.quote?.source).toBe("rule");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const shown = (await h.get(`/api/cards/${card.id}`)).json<CardJson>();
    expect(shown.quote?.label).toBe("Gemma offline · rule odds");
    expect(shown.gemma).toMatchObject({
      state: "offline",
      note: "Gemma is busy with other requests.",
      can_retry: true,
    });
  });

  it("a bet whose answer is saved waits in 'Settle when Gemma is back' while the queue is full", async () => {
    const h = await setup();
    h.model.setScenario("judge", "offline");
    const betId = seedBet(h);
    const answered = await h.post(`/api/bets/${betId}/settle`, { answer: "moist" });
    expect(answered.statusCode).toBe(202);
    h.clock.current += HOUR;
    fillQueue(h);
    await h.core.scheduler.tickSettlement();
    const slips = (await h.get("/api/slips")).json<{
      settle_now: { id: number; status: string; settle: { note: string } }[];
    }>();
    const waiting = slips.settle_now.find((bet) => bet.id === betId);
    expect(waiting?.status).toBe("awaiting_gemma");
    expect(waiting?.settle.note).toContain("Settle when Gemma is back");
    expect(count(h, "settlements")).toBe(0);
  });
});
