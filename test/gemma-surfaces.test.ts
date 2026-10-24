import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/server/db.js";
import { compactToolResult, formatForecast } from "../src/server/gemma/forecast-tool.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { FAKE_WEATHER_PROFILES, fakeForecastHours } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { HOUR, tap } from "./support/settle.js";

interface Band {
  band: number;
  band_name: string;
  odds: number;
}
interface Decision {
  job: string;
  model: string;
  fake: boolean;
  digest: string | null;
  prompt_version: string;
  tool_mode: string | null;
  forecast: { hour: string; rain_mm: number | null; rain_prob_pct: number | null }[] | null;
  retries: number;
  latency_ms: number;
}
interface CardJson {
  id: number;
  quote: { id: number; source: string; band: number } | null;
  rule?: Band;
  decision?: Decision | null;
}
interface BetJson {
  id: number;
  odds_source: string;
  rule: Band;
  gemma: Band | null;
  decision: Decision | null;
  settle_at: string;
}

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(): Promise<CoreHarness> {
  harness = await createCoreHarness({ weatherProfile: FAKE_WEATHER_PROFILES.breezy });
  await pair(harness);
  harness.clock.current = Date.UTC(2026, 9, 22, 8, 0);
  return harness;
}

const cards = async (h: CoreHarness): Promise<CardJson[]> =>
  (await h.get("/api/today")).json<{ cards: CardJson[] }>().cards;

describe("migration 0016: gemma_decisions.tool_result", () => {
  it("is number 16, adds one nullable column and keeps the decisions that exist", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids).toContain(16);
    const db = openDatabase(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.id <= 15),
    );
    db.exec(`INSERT INTO gemma_decisions (job, model, prompt_version, valid, retries, latency_ms, created_at)
             VALUES ('bookmaker', 'gemma4:e4b', 'bookmaker.v1', 1, 0, 900, 5)`);
    const before = db.prepare("SELECT * FROM gemma_decisions").all();
    expect(migrate(db, MIGRATIONS)).toEqual(ids.filter((id) => id > 15));
    expect(db.prepare("SELECT * FROM gemma_decisions").all()).toEqual(
      before.map((row) => ({ ...(row as object), tool_result: null })),
    );
    db.close();
  });
});

describe("AC-028.4: what the tool returned is kept with the decision, compactly and publicly", () => {
  it("keeps up to 24 hours of rain, chance of rain, temperature, wind and sunshine", () => {
    const hours = fakeForecastHours(FAKE_WEATHER_PROFILES.breezy, Date.UTC(2026, 9, 22, 8, 0), 30);
    const kept = JSON.parse(compactToolResult(formatForecast(hours))!) as unknown[][];
    expect(kept).toHaveLength(24);
    expect(kept[0]).toHaveLength(6);
    expect(kept[0]![0]).toMatch(/^\d\d:00$/);
  });

  it("is undefined for anything that is not a forecast", () => {
    expect(
      compactToolResult("Invalid arguments: hours_ahead must be a whole number"),
    ).toBeUndefined();
    expect(compactToolResult("<untrusted_data>\nnot json\n</untrusted_data>")).toBeUndefined();
  });
});

describe("AC-028.3, AC-028.4: a slip says whose odds they are and how Gemma decided", () => {
  it("shows Gemma's quote with the rule's band beside it and the decision behind it", async () => {
    const h = await setup();
    h.model.setScenario("bookmaker", "ok-digest");
    await h.post("/api/cards/quick", { chore_type: "plants" });
    await h.idle();
    const [card] = await cards(h);
    expect(card?.quote).toMatchObject({ source: "gemma", band: 2 });
    // The rule said "unlikely" (band 1) on this forecast: the two bands are both in the payload.
    expect(card?.rule).toMatchObject({ band: 1, band_name: "unlikely", odds: 35 });
    expect(card?.decision).toMatchObject({
      job: "bookmaker",
      fake: true,
      tool_mode: "called",
      retries: 0,
    });
    expect(card?.decision?.model).toMatch(/^fake/);
    expect(card?.decision?.digest).toMatch(/^[0-9a-z]{1,12}$/);
    expect(card?.decision?.prompt_version).toMatch(/^bookmaker/);
    expect(card?.decision?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(card?.decision?.forecast).toHaveLength(6);
    expect(card?.decision?.forecast?.[0]?.hour).toMatch(/^\d\d:00$/);
  });

  it("has no Gemma decision to disclose on rule odds, but still names the rule's band", async () => {
    const h = await setup();
    // The harness keeps the bookmaker offline unless a test brings it online.
    await h.post("/api/cards/quick", { chore_type: "plants" });
    await h.idle();
    const [card] = await cards(h);
    expect(card?.quote?.source).toBe("rule");
    expect(card?.decision).toBeNull();
    expect(card?.rule?.band).toBe(card?.quote?.band);
  });

  it("keeps household text and the input summary out of the disclosure", async () => {
    const h = await setup();
    h.model.setScenario("bookmaker", "ok");
    await h.post("/api/cards", { text: "water the basil on my balcony" });
    await h.idle();
    const [card] = await cards(h);
    const text = JSON.stringify(card?.decision);
    expect(text).not.toContain("input_summary");
    expect(text).not.toContain("basil");
    expect(text).not.toContain("rule band");
    expect(Object.keys(card?.decision ?? {}).sort()).toEqual([
      "digest",
      "fake",
      "forecast",
      "job",
      "latency_ms",
      "model",
      "prompt_version",
      "retries",
      "tool_mode",
    ]);
  });
});

describe("AC-028.3, AC-028.4: placed bets and receipts say whose odds they were", () => {
  it("shows both bands and the pricing decision on a waiting bet, and both decisions on the receipt", async () => {
    const h = await setup();
    h.model.setScenario("bookmaker", "ok-digest");
    await h.post("/api/cards/quick", { chore_type: "plants" });
    await h.idle();
    const [card] = await cards(h);
    const placed = await h.post("/api/bets", {
      card_id: card!.id,
      quote_id: card!.quote!.id,
      kind: "do_nothing",
    });
    expect(placed.statusCode).toBe(201);
    const waiting = (await h.get("/api/slips")).json<{ waiting: BetJson[] }>().waiting[0]!;
    expect(waiting).toMatchObject({ odds_source: "gemma" });
    expect(waiting.gemma).toMatchObject({ band: 2, band_name: "toss-up", odds: 50 });
    expect(waiting.rule).toMatchObject({ band: 1, band_name: "unlikely", odds: 35 });
    expect(waiting.decision).toMatchObject({ job: "bookmaker", tool_mode: "called", fake: true });
    // The night goes by and a tap settles it: the judge decides, and the receipt shows both.
    h.clock.current = Date.parse(waiting.settle_at) + HOUR;
    expect((await tap(h, waiting.id, "moist")).status).toBe(200);
    const settled = (await h.get("/api/slips")).json<{
      settled: { receipt: Record<string, unknown> }[];
    }>().settled[0]!.receipt;
    expect(settled).toMatchObject({
      odds_source: "gemma",
      odds_reason: expect.any(String) as unknown,
    });
    const decisions = settled["decisions"] as { odds: Decision | null; verdict: Decision | null };
    expect(decisions.odds).toMatchObject({ job: "bookmaker", fake: true });
    expect(decisions.verdict).toMatchObject({ job: "judge", fake: true });
    expect((settled["rule"] as Band).band).toBe(1);
  });

  it("a bet on rule odds says so, with no pricing decision", async () => {
    const h = await setup();
    await h.post("/api/cards/quick", { chore_type: "plants" });
    await h.idle();
    const [card] = await cards(h);
    await h.post("/api/bets", { card_id: card!.id, quote_id: card!.quote!.id, kind: "do_nothing" });
    const open = (await h.get("/api/slips")).json<{ waiting: BetJson[] }>().waiting[0]!;
    expect(open).toMatchObject({ odds_source: "rule", gemma: null, decision: null });
    expect(open.rule.band).toBeGreaterThanOrEqual(0);
  });
});
