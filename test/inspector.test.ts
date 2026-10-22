import { afterEach, describe, expect, it, vi } from "vitest";

import { JobQueueFullError } from "../src/server/gemma/runner.js";
import type { ChatRequest, ChatResponse } from "../src/server/model/client.js";
import { FakeModelClient } from "../src/server/model/fake.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";
import { recoverInspections } from "../src/server/ledger/photo-odds.js";
import { judgeScenarioFromAnswer } from "../src/server/fakes.js";

import { createCoreHarness, pair, uploadPhoto, type CoreHarness } from "./core-helpers.js";
import { GatedModel, HoldableModel, type BetJson, type CardJson } from "./gemma-support.js";
import { syntheticPhoto } from "./support/photos.js";

type PhotoCard = CardJson & {
  photo: {
    id: string;
    url: string;
    state: "inspecting" | "seen" | "unsure" | "failed";
    saw: { name: string; label: string; value: string }[];
    question: string | null;
    note: string | null;
    odds_change: { before: number; after: number; text: string } | null;
  } | null;
  quote: (CardJson["quote"] & { with_photo: boolean }) | null;
};

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(model: FakeModelClient = new HoldableModel()) {
  harness = await createCoreHarness({
    model,
    weatherProfile: FAKE_WEATHER_PROFILES.mild,
    runner: { deadlineMs: 45_000 },
  });
  await pair(harness);
  return { h: harness, model };
}

/** A plants card whose Gemma odds are "unlikely" (35%), the odds the photo then moves. */
async function cardAt35(h: CoreHarness, model: FakeModelClient): Promise<PhotoCard> {
  model.setScenario("bookmaker", "unlikely-24h");
  const created = await h.post("/api/cards/quick", { chore_type: "plants" });
  await h.idle();
  const view = await getCard(h, created.json<{ id: number }>().id);
  expect(view.quote).toMatchObject({ source: "gemma", odds: 35 });
  return view;
}

async function getCard(h: CoreHarness, id: number): Promise<PhotoCard> {
  return (await h.get(`/api/cards/${id}`)).json<PhotoCard>();
}

async function sendPhoto(h: CoreHarness, cardId: number): Promise<void> {
  const response = await uploadPhoto(
    h,
    cardId,
    await syntheticPhoto({ width: 1800, height: 1200 }),
  );
  expect(response.statusCode).toBe(201);
  await h.idle();
}

const callsOf = (model: FakeModelClient, job: string): ChatRequest[] =>
  model.calls.filter((call) => call.job === job);

describe("REQ-005: the inspector and the sharper odds", () => {
  it("AC-005.2: a stored photo goes to the inspector, then the bookmaker is re-run with what it saw", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("bookmaker", "ok");
    const response = await uploadPhoto(
      h,
      card.id,
      await syntheticPhoto({ width: 1800, height: 1200 }),
    );
    expect(response.statusCode).toBe(201);
    // The answer does not wait for Gemma: the card is inspecting, the old odds still shown.
    const body = response.json<{ card: PhotoCard; photo: { id: string } }>();
    expect(body.card.photo).toMatchObject({
      state: "inspecting",
      note: "Gemma is looking at your photo.",
    });
    expect(body.card.quote).toMatchObject({ odds: 35 });
    await h.idle();

    const [inspect] = callsOf(model, "inspector");
    expect(inspect?.images).toHaveLength(1);
    // What Gemma gets is the stored, shrunk copy: a JPEG within 1024 px, not the upload.
    const stored = h.photos.read(`${body.photo.id}.jpg`);
    expect(Buffer.from(inspect!.images![0]!).equals(stored)).toBe(true);
    const photoRun = callsOf(model, "bookmaker").at(-1);
    const user = photoRun?.messages[1]?.content ?? "";
    expect(user).toContain("photo_observations");
    expect(user).toContain("tomato pots");
    // Two calls for the first run (tool call, answer) and two for the run with the photo.
    expect(callsOf(model, "bookmaker")).toHaveLength(4);
  });

  it("AC-005.3: the card lists What Gemma saw and the odds before → after", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("bookmaker", "ok");
    await sendPhoto(h, card.id);
    const view = await getCard(h, card.id);
    expect(view.photo).toMatchObject({
      state: "seen",
      question: null,
      note: null,
      odds_change: { before: 35, after: 50, text: "35% → 50%" },
    });
    expect(view.photo?.saw).toEqual([
      { name: "item", label: "Item", value: "tomato pots" },
      { name: "soil_dryness", label: "Soil", value: "dry" },
      { name: "wilting", label: "Wilting", value: "none" },
      { name: "cover", label: "Cover from rain", value: "open" },
    ]);
    expect(view.quote).toMatchObject({
      source: "gemma",
      odds: 50,
      with_photo: true,
      label: "Gemma's odds",
    });
    // The same card on Today carries the photo block too.
    const today = (await h.get("/api/today")).json<{ cards: PhotoCard[] }>();
    expect(today.cards[0]?.photo?.odds_change?.text).toBe("35% → 50%");
  });

  it("AC-005.4: an unsure inspector keeps the odds without the photo and shows Gemma's question", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("inspector", "unsure");
    await sendPhoto(h, card.id);
    const view = await getCard(h, card.id);
    expect(view.photo).toMatchObject({
      state: "unsure",
      saw: [],
      question: "Is the soil visible in the photo?",
      odds_change: null,
    });
    expect(view.quote).toMatchObject({ id: card.quote!.id, odds: 35, with_photo: false });
    // No second bookmaker run for a photo that told Gemma nothing.
    expect(callsOf(model, "bookmaker")).toHaveLength(2);
    expect(callsOf(model, "inspector")).toHaveLength(1);
  });

  it.each(["offline", "timeout", "invalid-json", "invalid-schema"])(
    "AC-005.4: an inspector that fails (%s) leaves the odds as they were",
    async (scenario) => {
      const { h, model } = await setup();
      const card = await cardAt35(h, model);
      model.setScenario("inspector", scenario);
      await sendPhoto(h, card.id);
      const view = await getCard(h, card.id);
      expect(view.photo).toMatchObject({ state: "failed", saw: [], odds_change: null });
      expect(view.photo?.note).toMatch(/The odds stay as they were\.$/);
      expect(view.quote).toMatchObject({ id: card.quote!.id, odds: 35 });
      // The bookmaker is not asked again without observations.
      expect(callsOf(model, "bookmaker")).toHaveLength(2);
    },
  );

  it("AC-005.2: an invalid first answer is retried once with the error, then used", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("inspector", "invalid-then-valid");
    model.setScenario("bookmaker", "ok");
    await sendPhoto(h, card.id);
    expect(callsOf(model, "inspector")).toHaveLength(2);
    expect((await getCard(h, card.id)).photo?.saw).toEqual([
      { name: "soil_dryness", label: "Soil", value: "dry" },
    ]);
    const retried = callsOf(model, "inspector")[1]?.messages.at(-1)?.content ?? "";
    expect(retried).toContain("rejected");
  });

  it("AC-005.3: a bookmaker that cannot update the odds keeps them and still shows what Gemma saw", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("bookmaker", "offline");
    await sendPhoto(h, card.id);
    const view = await getCard(h, card.id);
    expect(view.photo?.state).toBe("seen");
    expect(view.photo?.saw).toHaveLength(4);
    expect(view.photo?.odds_change).toBeNull();
    expect(view.photo?.note).toMatch(/odds stay as they were/);
    expect(view.quote).toMatchObject({ id: card.quote!.id, odds: 35 });
  });

  it("works from rule odds too: Gemma was offline, the photo brings Gemma's odds", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "offline");
    const created = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<PhotoCard>();
    await h.idle();
    model.setScenario("bookmaker", "ok");
    await sendPhoto(h, created.id);
    const view = await getCard(h, created.id);
    expect(view.photo?.odds_change).toMatchObject({ before: 35, after: 50 });
    expect(view.quote).toMatchObject({ source: "gemma", with_photo: true });
  });

  it("AC-005.2: Retry and a tap on Gemma's question keep reading the photo", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("bookmaker", "ok");
    await sendPhoto(h, card.id);
    model.setScenario("bookmaker", "unsure");
    // Force the card into 'question' as if Gemma asked something after the photo.
    h.db
      .prepare("UPDATE cards SET gemma_state = 'question', gemma_question = 'Roof?' WHERE id = ?")
      .run(card.id);
    model.setScenario("bookmaker", "ok");
    expect((await h.post(`/api/cards/${card.id}/answer`, { yes: true })).statusCode).toBe(200);
    await h.idle();
    const last = callsOf(model, "bookmaker").at(-1)?.messages[1]?.content ?? "";
    expect(last).toContain("tomato pots");
    const view = await getCard(h, card.id);
    expect(view.quote).toMatchObject({ with_photo: true });
    expect(view.photo?.odds_change?.text).toBe("35% → 50%");
  });

  it("a photo is refused while Gemma is still setting the first odds, and while another is inspected", async () => {
    const model = new HoldableModel();
    const { h } = await setup(model);
    model.hold();
    const created = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<PhotoCard>();
    const early = await uploadPhoto(h, created.id, await syntheticPhoto());
    expect(early.statusCode).toBe(409);
    model.release();
    await h.idle();
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM photos").get()).toEqual({ n: 0 });

    model.hold();
    expect((await uploadPhoto(h, created.id, await syntheticPhoto())).statusCode).toBe(201);
    // Inspector job runs on the fake and then waits at the held bookmaker.
    for (let waited = 0; waited < 50 && callsOf(model, "bookmaker").length < 2; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = await uploadPhoto(h, created.id, await syntheticPhoto());
    expect(second.statusCode).toBe(409);
    model.release();
    await h.idle();
  });

  it("a new photo replaces the old one, and the card falls back to the odds without any photo", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("bookmaker", "ok");
    await sendPhoto(h, card.id);
    model.setScenario("inspector", "unsure");
    await sendPhoto(h, card.id);
    const view = await getCard(h, card.id);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM photos").get()).toEqual({ n: 1 });
    expect(view.photo).toMatchObject({ state: "unsure", odds_change: null });
    expect(view.quote).toMatchObject({ odds: 35, with_photo: false });
  });

  it("NFR-003: a photo being inspected when the app stopped shows as failed, odds untouched", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    await sendPhoto(h, card.id);
    h.db.prepare("UPDATE cards SET photo_state = 'inspecting' WHERE id = ?").run(card.id);
    expect(recoverInspections(h)).toBe(1);
    expect((await getCard(h, card.id)).photo).toMatchObject({ state: "failed" });
  });

  it("puts the chore in a delimited data block and sends no household text or photo data to the log", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    await sendPhoto(h, card.id);
    const request = callsOf(model, "inspector")[0]!;
    expect(request.messages[0]?.content).toMatch(/data, not\s+instructions/);
    expect(request.messages[1]?.content).toMatch(/^<untrusted_data>/);
    const row = h.db
      .prepare<[], { input_summary: string }>(
        "SELECT input_summary FROM gemma_decisions WHERE job = 'inspector'",
      )
      .get();
    expect(row?.input_summary).toMatch(/^plants photo, 1024x683$/);
  });
});

describe("REQ-005: one 45 s deadline for the inspector and the bookmaker", () => {
  it("AC-005.2: the bookmaker after a photo gets only what is left of the photo's 45 s", async () => {
    // The inspector "takes" 30 s on the fake clock; the bookmaker then has 15 s, not 30.
    class SlowInspector extends FakeModelClient {
      constructor(private readonly advance: (ms: number) => void) {
        super({ scenario: judgeScenarioFromAnswer });
      }

      override chat(request: ChatRequest): Promise<ChatResponse> {
        if (request.job === "inspector") {
          this.advance(30_000);
        }
        return super.chat(request);
      }
    }
    let clockAdvance: (ms: number) => void = () => undefined;
    const model = new SlowInspector((ms) => {
      clockAdvance(ms);
    });
    const { h } = await setup(model);
    clockAdvance = (ms) => {
      h.clock.advance(ms);
    };
    const card = await cardAt35(h, model);
    model.setScenario("bookmaker", "ok");
    await sendPhoto(h, card.id);
    // The calls of the photo's bookmaker run are the ones whose data block holds the observations.
    const timeouts = callsOf(model, "bookmaker")
      .filter((call) => (call.messages[1]?.content ?? "").includes("photo_observations"))
      .map((call) => call.timeoutMs);
    expect(callsOf(model, "inspector")[0]?.timeoutMs).toBe(30_000);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(15_000);
    expect(timeouts.length).toBeGreaterThan(0);
  });
});

describe("REQ-005: the bet stores the band with and without the photo", () => {
  async function place(h: CoreHarness, card: PhotoCard): Promise<BetJson> {
    const latest = await getCard(h, card.id);
    const response = await h.post("/api/bets", {
      card_id: card.id,
      quote_id: latest.quote!.id,
      kind: "do_nothing",
    });
    expect(response.statusCode).toBe(201);
    return response.json<BetJson>();
  }

  const row = (h: CoreHarness, betId: number) =>
    h.db
      .prepare<[number], { band: number; band_without_photo: number | null; gemma_band: number }>(
        "SELECT band, band_without_photo, gemma_band FROM bets WHERE id = ?",
      )
      .get(betId);

  it("AC-005.5: a bet placed with a photo stores both bands in the INSERT", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("bookmaker", "ok");
    await sendPhoto(h, card.id);
    const bet = await place(h, card);
    expect(row(h, bet.id)).toMatchObject({ band: 2, band_without_photo: 1 });
    // Write-once: the database refuses a rewrite.
    expect(() =>
      h.db.prepare("UPDATE bets SET band_without_photo = 3 WHERE id = ?").run(bet.id),
    ).toThrow();
  });

  it("AC-005.5: a photo that did not change the odds (unsure) still records the band without it", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("inspector", "unsure");
    await sendPhoto(h, card.id);
    const bet = await place(h, card);
    expect(row(h, bet.id)).toMatchObject({ band: 1, band_without_photo: 1 });
  });

  it("AC-005.5: a bet on a card without a photo has no band without photo", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    const bet = await place(h, card);
    expect(row(h, bet.id)).toMatchObject({ band: 1, band_without_photo: null });
  });

  it("AC-006.2: a photo answer that arrives after the bet does not touch it", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    model.setScenario("bookmaker", "ok");
    await sendPhoto(h, card.id);
    const bet = await place(h, card);
    const view = await getCard(h, card.id);
    expect(view.quote).toMatchObject({ odds: 50 });
    expect(bet.odds).toBe(50);
    expect((await uploadPhoto(h, card.id, await syntheticPhoto())).statusCode).toBe(409);
  });
});

describe("review fixes: which odds count as 'without the photo' (B3)", () => {
  it("B3: a photo answer that moves the settle time still shows Gemma's earlier odds as 'before'", async () => {
    const { h, model } = await setup();
    // Gemma's first answer: toss-up (50%); the rule says unlikely (35%).
    model.setScenario("bookmaker", "ok");
    const created = await h.post("/api/cards/quick", { chore_type: "plants" });
    await h.idle();
    const card = created.json<PhotoCard>();
    // With the photo: unlikely (35%) and a different settle time, so a rule quote is added too.
    model.setScenario("bookmaker", "unlikely-late");
    await sendPhoto(h, card.id);
    const rows = h.db
      .prepare<[], { source: string; with_photo: number; band: number }>(
        "SELECT source, with_photo, band FROM quotes ORDER BY id",
      )
      .all();
    // The rule quote for the new window sits between Gemma's first answer and the photo's.
    const kinds = rows.map((row) => `${row.source}${row.with_photo === 1 ? "+photo" : ""}`);
    expect(kinds.slice(-2)).toEqual(["rule", "gemma+photo"]);
    expect(kinds.filter((kind) => kind === "gemma")).toHaveLength(1);
    const view = await getCard(h, card.id);
    expect(view.photo?.odds_change).toMatchObject({ before: 50, after: 35, text: "50% → 35%" });
    const bet = await h.post("/api/bets", {
      card_id: card.id,
      quote_id: view.quote!.id,
      kind: "do_nothing",
    });
    expect(bet.statusCode).toBe(201);
    expect(h.db.prepare("SELECT band, band_without_photo FROM bets").get()).toEqual({
      band: 1,
      band_without_photo: 2,
    });
  });

  it("B3: with no Gemma answer without the photo, the rule quote is the 'before'", async () => {
    const { h, model } = await setup();
    model.setScenario("bookmaker", "offline");
    const card = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<PhotoCard>();
    await h.idle();
    model.setScenario("bookmaker", "ok");
    await sendPhoto(h, card.id);
    expect((await getCard(h, card.id)).photo?.odds_change).toMatchObject({ before: 35, after: 50 });
  });
});

describe("review fixes: Retry, answers, safety and bets while a photo is inspected", () => {
  it("S2: Retry and a tap on Gemma's question are refused while the photo is inspected", async () => {
    const model = new GatedModel();
    const { h } = await setup(model);
    model.setScenario("bookmaker", "ok");
    const created = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<PhotoCard>();
    await h.idle();
    model.gate("inspector");
    expect((await uploadPhoto(h, created.id, await syntheticPhoto())).statusCode).toBe(201);
    await model.waitForArrivals("inspector", 1);
    // The card would offer Retry only when offline: force both states to prove the guard.
    h.db.prepare("UPDATE cards SET gemma_state = 'offline' WHERE id = ?").run(created.id);
    expect((await h.post(`/api/cards/${created.id}/retry`, {})).statusCode).toBe(409);
    h.db
      .prepare("UPDATE cards SET gemma_state = 'question', gemma_question = 'Roof?' WHERE id = ?")
      .run(created.id);
    expect((await h.post(`/api/cards/${created.id}/answer`, { yes: true })).statusCode).toBe(409);
    model.openAll();
    await h.idle();
  });

  it("N6, AC-012.1: heat inside the window the photo's answer settles on turns the card into an alert", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    const real = h.weather.getForecast.bind(h.weather);
    // Safe until 23 h from now; 40 °C in the hour before the 24 h settle time.
    h.weather.getForecast = async (request) => {
      const forecast = await real(request);
      return {
        ...forecast,
        hours: forecast.hours.map((hour) =>
          hour.startsAt >= h.clock.now() + 23 * 3_600_000 ? { ...hour, temperatureC: 40 } : hour,
        ),
      };
    };
    model.setScenario("bookmaker", "unlikely-24h");
    await sendPhoto(h, card.id);
    const view = (await h.get(`/api/cards/${card.id}`)).json<{
      kind: string;
      quote: unknown;
      photo: unknown;
    }>();
    expect(view).toMatchObject({ kind: "alert", quote: null, photo: null });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM quotes WHERE with_photo = 1").get()).toEqual({
      n: 0,
    });
    const bet = await h.post("/api/bets", {
      card_id: card.id,
      quote_id: card.quote!.id,
      kind: "do_nothing",
    });
    expect(bet.statusCode).toBe(409);
  });

  it("AC-006.2: a bet placed while the bookmaker reads the photo is not touched; the photo says so", async () => {
    const model = new GatedModel();
    const { h } = await setup(model);
    model.setScenario("bookmaker", "ok");
    const created = (await h.post("/api/cards/quick", { chore_type: "plants" })).json<PhotoCard>();
    await h.idle();
    model.gate("bookmaker");
    expect((await uploadPhoto(h, created.id, await syntheticPhoto())).statusCode).toBe(201);
    await model.waitForArrivals("bookmaker", 1);
    const bet = await h.post("/api/bets", {
      card_id: created.id,
      quote_id: (await getCard(h, created.id)).quote!.id,
      kind: "do_nothing",
    });
    expect(bet.statusCode).toBe(201);
    model.openAll();
    await h.idle();
    const view = await getCard(h, created.id);
    expect(view.photo).toMatchObject({ state: "seen", odds_change: null });
    expect(view.photo?.note).toBe(
      "Your bet was placed before Gemma answered. The odds stay as they were.",
    );
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM quotes WHERE with_photo = 1").get()).toEqual({
      n: 0,
    });
    expect(h.db.prepare("SELECT odds FROM bets").get()).toEqual({ odds: 50 });
  });

  it("a full Gemma queue during the photo's jobs keeps the odds and says Gemma is busy", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    const original = h.core.gemma.run.bind(h.core.gemma);
    let runs = 0;
    vi.spyOn(h.core.gemma, "run").mockImplementation((request) => {
      runs += 1;
      return runs === 1 ? original(request) : Promise.reject(new JobQueueFullError("full"));
    });
    await sendPhoto(h, card.id);
    const view = await getCard(h, card.id);
    expect(view.photo).toMatchObject({ state: "seen", odds_change: null });
    expect(view.photo?.note).toBe("Gemma is busy with other requests. The odds stay as they were.");
    expect(view.quote).toMatchObject({ odds: 35 });
  });
});

describe("review fixes: an unexpected error keeps what was already read (S4)", () => {
  function failJob(h: CoreHarness, job: string): void {
    const original = h.core.gemma.run.bind(h.core.gemma);
    vi.spyOn(h.core.gemma, "run").mockImplementation((request) =>
      request.job === job ? Promise.reject(new Error("boom")) : original(request),
    );
  }

  it("S4: an error before the inspector read anything marks the photo failed (internal), odds untouched", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    failJob(h, "inspector");
    await sendPhoto(h, card.id);
    const view = await getCard(h, card.id);
    expect(view.photo).toMatchObject({ state: "failed", saw: [], odds_change: null });
    expect(view.photo?.note).toBe(
      "Something went wrong inside the app. The odds stay as they were.",
    );
    expect(view.quote).toMatchObject({ id: card.quote!.id });
  });

  it("S4: an error after the inspector read the photo keeps 'seen' and What Gemma saw", async () => {
    const { h, model } = await setup();
    const card = await cardAt35(h, model);
    failJob(h, "bookmaker");
    await sendPhoto(h, card.id);
    const view = await getCard(h, card.id);
    expect(view.photo?.state).toBe("seen");
    expect(view.photo?.saw).toHaveLength(4);
    expect(view.photo?.note).toBe(
      "Something went wrong inside the app. The odds stay as they were.",
    );
    expect(view.quote).toMatchObject({ id: card.quote!.id });
  });
});
