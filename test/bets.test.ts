import { afterEach, describe, expect, it } from "vitest";

import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";

const MINUTE = 60_000;

let harness: CoreHarness;
afterEach(async () => {
  await harness.close();
});

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}): Promise<CoreHarness> {
  harness = await createCoreHarness({ weatherProfile: FAKE_WEATHER_PROFILES.rainy, ...options });
  await pair(harness);
  return harness;
}

interface Card {
  id: number;
  quote: { id: number; band: number; odds: number; reason: string; settle_at: string };
}
interface Bet {
  id: number;
  card_id: number;
  kind: string;
  status: string;
  band: number;
  odds: number;
  odds_source: string;
  reason: string;
  settle_at: string;
  undo_until: string;
  undoable: boolean;
  payouts: Record<string, number>;
}
interface Today {
  cards: { id: number }[];
  open_bets: Bet[];
  due_bets: Bet[];
}

async function quickCard(): Promise<Card> {
  return (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<Card>();
}

async function latestQuoteId(cardId: number): Promise<number> {
  return (await harness.get(`/api/cards/${cardId}`)).json<Card>().quote.id;
}

async function place(cardId: number, kind: "do_nothing" | "do_it" = "do_nothing"): Promise<Bet> {
  const response = await harness.post("/api/bets", {
    card_id: cardId,
    quote_id: await latestQuoteId(cardId),
    kind,
  });
  expect(response.statusCode).toBe(201);
  return response.json<Bet>();
}

async function today(): Promise<Today> {
  return (await harness.get("/api/today")).json<Today>();
}

function row(id: number): Record<string, unknown> {
  return harness.db
    .prepare<[number], Record<string, unknown>>("SELECT * FROM bets WHERE id = ?")
    .get(id)!;
}

describe("REQ-006: bet, do it, or undo", () => {
  it("AC-006.1: the bet locks the odds, band, source, reason and settle time shown", async () => {
    await setup();
    const card = await quickCard();
    const bet = await place(card.id);
    expect(bet).toMatchObject({
      kind: "do_nothing",
      status: "open",
      band: card.quote.band,
      odds: card.quote.odds,
      odds_source: "rule",
      reason: card.quote.reason,
      settle_at: card.quote.settle_at,
    });
    expect(row(bet.id)).toMatchObject({
      band: card.quote.band,
      odds: card.quote.odds,
      odds_source: "rule",
      reason: card.quote.reason,
      settle_at: Date.parse(card.quote.settle_at),
    });
  });

  it("AC-006.2: a forecast change and a newer Gemma quote leave the bet's odds, band and payouts unchanged", async () => {
    await setup();
    const card = await quickCard();
    const bet = await place(card.id);
    const before = row(bet.id);

    harness.weather.setProfile(FAKE_WEATHER_PROFILES.hot);
    const hotCard = await quickCard();
    expect(hotCard.quote.odds).toBe(15);
    // Gemma answers on the card after the bet: a newer quote with other odds.
    harness.db
      .prepare(
        `INSERT INTO quotes (card_id, source, band, odds, with_photo, reason, settle_at, created_at)
         VALUES (?, 'gemma', 0, 15, 0, 'Gemma changed its mind', ?, ?)`,
      )
      .run(card.id, Date.parse(card.quote.settle_at), harness.clock.now());
    harness.clock.advance(2 * MINUTE);

    expect(row(bet.id)).toEqual(before);
    const [open] = (await today()).open_bets;
    expect(open).toMatchObject({
      id: bet.id,
      odds: 70,
      band: 3,
      reason: card.quote.reason,
      payouts: bet.payouts,
    });
  });

  it("AC-006.3: I'll do it records a do-it decision with the same odds and settle time", async () => {
    await setup();
    const card = await quickCard();
    const decision = await place(card.id, "do_it");
    expect(decision).toMatchObject({
      kind: "do_it",
      status: "open",
      odds: card.quote.odds,
      band: card.quote.band,
      settle_at: card.quote.settle_at,
      payouts: { do_it_if_not_needed: 5, do_it_if_needed: -10 },
    });
    expect((await today()).cards).toEqual([]);
    expect((await today()).open_bets.map((b) => [b.id, b.kind])).toEqual([[decision.id, "do_it"]]);
  });

  it("AC-006.3: a card holds one decision, so a bet and a do-it cannot both be placed", async () => {
    await setup();
    const card = await quickCard();
    await place(card.id, "do_it");
    const second = await harness.post("/api/bets", {
      card_id: card.id,
      quote_id: card.quote.id,
      kind: "do_nothing",
    });
    expect(second.statusCode).toBe(409);
  });

  it("AC-006.3: I'll do it follows the same quote_id rule as a bet", async () => {
    await setup();
    const card = await quickCard();
    harness.db
      .prepare(
        `INSERT INTO quotes (card_id, source, band, odds, with_photo, reason, settle_at, created_at)
         VALUES (?, 'gemma', 0, 15, 0, 'Gemma changed its mind', ?, ?)`,
      )
      .run(card.id, Date.parse(card.quote.settle_at), harness.clock.now());
    const stale = await harness.post("/api/bets", {
      card_id: card.id,
      quote_id: card.quote.id,
      kind: "do_it",
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ title: "The odds changed" });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 0 });
  });

  it.each(["do_nothing", "do_it"] as const)(
    "AC-006.4: Undo within 5 minutes removes the %s with no points, keeping a row marked undone",
    async (kind) => {
      await setup();
      const card = await quickCard();
      const bet = await place(card.id, kind);
      expect(bet.undoable).toBe(true);
      expect(Date.parse(bet.undo_until) - harness.clock.now()).toBe(5 * MINUTE);

      harness.clock.advance(3 * MINUTE);
      const undone = await harness.delete(`/api/bets/${bet.id}`);
      expect(undone.statusCode).toBe(200);
      expect(undone.json()).toMatchObject({ id: bet.id, status: "undone", undoable: false });

      // Gone from Today and Slips, the card is offered again, no points, the row is kept.
      const now = await today();
      expect(now.open_bets).toEqual([]);
      expect(now.cards.map((c) => c.id)).toEqual([card.id]);
      expect(
        (await harness.get("/api/slips")).json<{ waiting: unknown[]; settled: unknown[] }>(),
      ).toMatchObject({ waiting: [], settled: [] });
      expect(row(bet.id)).toMatchObject({ status: "undone", kind });
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 0 });
      expect((await harness.get("/api/today")).json<{ points: unknown }>().points).toEqual({
        total: 0,
      });

      // The card can be bet on again after an undo.
      const again = await place(card.id);
      expect(again.id).not.toBe(bet.id);
    },
  );

  it("AC-006.4: Undo works up to and including the fifth minute", async () => {
    await setup();
    const bet = await place((await quickCard()).id);
    harness.clock.advance(5 * MINUTE);
    expect((await harness.delete(`/api/bets/${bet.id}`)).statusCode).toBe(200);
  });

  it("AC-006.5: after 5 minutes Undo is not offered and the API answers 409, the bet is locked", async () => {
    await setup();
    const bet = await place((await quickCard()).id);
    harness.clock.advance(5 * MINUTE + 1);

    const [open] = (await today()).open_bets;
    expect(open).toMatchObject({ id: bet.id, status: "open", undoable: false });
    const late = await harness.delete(`/api/bets/${bet.id}`);
    expect(late.statusCode).toBe(409);
    expect(late.headers["content-type"]).toContain("application/problem+json");
    expect(late.json()).toMatchObject({ status: 409, title: "This bet is locked" });
    expect(row(bet.id)).toMatchObject({ status: "open" });
  });

  it("AC-006.5: a bet that is already due or settled cannot be undone either", async () => {
    await setup();
    const bet = await place((await quickCard()).id);
    harness.clock.current = Date.parse(bet.settle_at) + MINUTE;
    harness.core.scheduler.tick();
    expect((await harness.delete(`/api/bets/${bet.id}`)).statusCode).toBe(409);
    await harness.post(`/api/bets/${bet.id}/settle`, { answer: "moist" });
    expect((await harness.delete(`/api/bets/${bet.id}`)).statusCode).toBe(409);
    expect(row(bet.id)).toMatchObject({ status: "settled" });
  });

  it("AC-006.5: a bet whose settle time passed inside the 5 minutes is due, so Undo is refused like everywhere else", async () => {
    await setup();
    const card = await quickCard();
    const now = harness.clock.now();
    const id = Number(
      harness.db
        .prepare(
          `INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at,
             undo_until, settle_at, status)
           VALUES (?, 'do_nothing', 3, 70, 'rule', 'r', 3, ?, ?, ?, 'open')`,
        )
        .run(card.id, now, now + 5 * MINUTE, now + 2 * MINUTE).lastInsertRowid,
    );
    harness.clock.advance(3 * MINUTE); // inside the window, but past the settle time; no tick ran
    const late = await harness.delete(`/api/bets/${id}`);
    expect(late.statusCode).toBe(409);
    expect(row(id)).toMatchObject({ status: "due" });
  });

  it("answers 404 for an unknown bet, 409 for a second undo and 400 for a bad id", async () => {
    await setup();
    expect((await harness.delete("/api/bets/999")).statusCode).toBe(404);
    expect((await harness.delete("/api/bets/abc")).statusCode).toBe(400);
    const bet = await place((await quickCard()).id);
    expect((await harness.delete(`/api/bets/${bet.id}`)).statusCode).toBe(200);
    expect((await harness.delete(`/api/bets/${bet.id}`)).statusCode).toBe(409);
  });

  it("AC-001.4: Undo needs a session and a same-origin Origin like every other write", async () => {
    await setup();
    const bet = await place((await quickCard()).id);
    const noOrigin = await harness.request({
      method: "DELETE",
      url: `/api/bets/${bet.id}`,
      headers: { cookie: harness.cookie },
    });
    expect(noOrigin.statusCode).toBe(403);
    const noSession = await harness.request({ method: "DELETE", url: `/api/bets/${bet.id}` });
    expect(noSession.statusCode).toBe(401);
    expect(row(bet.id)).toMatchObject({ status: "open" });
  });

  it("an undone bet can never be revived, even by a direct update", async () => {
    await setup();
    const bet = await place((await quickCard()).id);
    await harness.delete(`/api/bets/${bet.id}`);
    expect(() =>
      harness.db.prepare("UPDATE bets SET status = 'open' WHERE id = ?").run(bet.id),
    ).toThrow(/state machine/);
  });
});

describe("cards that are not weather bets", () => {
  it.each(["not_weather", "coming_later"] as const)(
    "a %s card has no bet or do-it action: 409 and nothing stored",
    async (cardKind) => {
      await setup();
      const cardId = Number(
        harness.db
          .prepare(
            "INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('x', 'plants', ?, ?)",
          )
          .run(cardKind, harness.clock.now()).lastInsertRowid,
      );
      for (const kind of ["do_nothing", "do_it"]) {
        const response = await harness.post("/api/bets", { card_id: cardId, quote_id: 1, kind });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ title: "No bet on this card" });
      }
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 0 });
    },
  );
});

describe("REQ-012 AC-012.2: no bet on a card in alert state", () => {
  function seedAlertCard(): number {
    return Number(
      harness.db
        .prepare(
          `INSERT INTO cards (input_text, chore_type, kind, alert_reason, created_at)
           VALUES ('Water plants', 'plants', 'alert', 'Frost tonight: bring the plants in.', ?)`,
        )
        .run(harness.clock.now()).lastInsertRowid,
    );
  }

  it.each(["do_nothing", "do_it"] as const)(
    "AC-012.2: placing a %s on an alert card is rejected and nothing is stored",
    async (kind) => {
      await setup();
      const cardId = seedAlertCard();
      const response = await harness.post("/api/bets", {
        card_id: cardId,
        quote_id: 1,
        kind,
      });
      expect(response.statusCode).toBe(409);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({
        title: "No bet on an alert",
        detail: "Frost tonight: bring the plants in.",
      });
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 0 });
    },
  );
});
