import { afterEach, describe, expect, it } from "vitest";

import type { Band } from "../src/domain/bands.js";
import { MIN_BETS_PER_BAND } from "../src/domain/calibration.js";
import { savingsSnapshotText } from "../src/server/ledger/savings.js";
import { loadSavings } from "../src/server/savings.js";
import type { Score } from "../src/server/ledger/score.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";
import { scoreSchema } from "../src/web/api.js";

import { EXAMPLE_HOUSEHOLD, createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { HOUR, MINUTE, seedBet, tap } from "./support/settle.js";

let harness: CoreHarness;
let opened = false;
afterEach(async () => {
  if (opened) {
    await harness.close();
    opened = false;
  }
});

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}): Promise<void> {
  harness = await createCoreHarness({ flags: { score: true }, ...options });
  opened = true;
  await pair(harness);
}

const ODDS = { 0: 15, 1: 35, 2: 50, 3: 70, 4: 85 } as const;
const REAL_MODEL = "gemma4:e4b@sha256:test";

interface SeedSettled {
  readonly kind?: "do_nothing" | "do_it";
  /** The band on the slip. For a Gemma bet this is also `gemma_band`. */
  readonly band: Band;
  readonly ruleBand?: Band;
  readonly source?: "rule" | "gemma";
  readonly modelVersion?: string | null;
  readonly status?: string;
  /** Verdict of the final settlement; null: no settlement row at all. */
  readonly verdict?: string | null;
  readonly points?: number;
  readonly luckyWin?: 0 | 1 | null;
  readonly chore?: string;
}

/** A settled bet straight in the database: the Score reads rows, not how they came about. */
function seedSettled(options: SeedSettled): number {
  const now = harness.clock.current;
  const chore = options.chore ?? "plants";
  const source = options.source ?? "gemma";
  const kind = options.kind ?? "do_nothing";
  const card = Number(
    harness.db
      .prepare(
        "INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('seed', ?, 'weather', ?)",
      )
      .run(chore, now - 30 * HOUR).lastInsertRowid,
  );
  const bet = Number(
    harness.db
      .prepare(
        `INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, gemma_band, rule_band,
           model_version, savings_snapshot, placed_at, undo_until, settle_at, status)
         VALUES (?, ?, ?, ?, ?, 'seed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card,
        kind,
        options.band,
        ODDS[options.band],
        source,
        source === "gemma" ? options.band : null,
        options.ruleBand ?? options.band,
        options.modelVersion === undefined
          ? source === "gemma"
            ? REAL_MODEL
            : null
          : options.modelVersion,
        savingsSnapshotText(
          { db: harness.db, household: EXAMPLE_HOUSEHOLD, savings: loadSavings() },
          chore,
        ),
        now - 30 * HOUR,
        now - 30 * HOUR + 5 * MINUTE,
        now - 2 * HOUR,
        options.status ?? "settled",
      ).lastInsertRowid,
  );
  if (options.verdict !== null) {
    const verdict = options.verdict ?? (kind === "do_it" ? "weather_would_not" : "win");
    insertSettlement(bet, verdict, options.points ?? (verdict === "win" ? 15 : -25), {
      luckyWin: options.luckyWin ?? null,
    });
  }
  return bet;
}

function insertSettlement(
  betId: number,
  verdict: string,
  points: number,
  extra: { luckyWin?: 0 | 1 | null; final?: 0 | 1; appealOf?: number } = {},
): number {
  return Number(
    harness.db
      .prepare(
        `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, lucky_win, points,
           settled_at, appeal_of, final)
         VALUES (?, 'tap', 0.5, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        betId,
        verdict,
        extra.luckyWin ?? null,
        points,
        harness.clock.current - HOUR,
        extra.appealOf ?? null,
        extra.final ?? 1,
      ).lastInsertRowid,
  );
}

async function score(): Promise<Score> {
  const response = await harness.get("/api/score");
  expect(response.statusCode).toBe(200);
  return response.json<Score>();
}

describe("REQ-020: Score screen data", () => {
  it("AC-029.2: with the score flag off there is no route; with it on a session is still required", async () => {
    await setup({ flags: {} });
    expect((await harness.get("/api/score")).statusCode).toBe(404);
    await harness.close();
    opened = false;

    await setup();
    expect((await score()).points.total).toBe(0);
    const unpaired = await harness.request({ method: "GET", url: "/api/score" });
    expect(unpaired.statusCode).toBe(401);
  });

  it("AC-020.1: total points are the sum of the final settlements, appeals replacing the first verdict", async () => {
    await setup();
    seedSettled({ band: 3, verdict: "win", points: 15 });
    seedSettled({ band: 2, verdict: "normal_loss", points: -50 });
    seedSettled({ kind: "do_it", band: 2, verdict: "weather_would_not", points: 5 });
    const appealed = seedSettled({ band: 1, verdict: "normal_loss", points: -50 });
    // The appeal replaces the first verdict: the first row stops being final.
    harness.db.prepare("UPDATE settlements SET final = 0 WHERE bet_id = ?").run(appealed);
    insertSettlement(appealed, "win", 32, { appealOf: 1 });
    // A bet that is not settled has no points.
    seedSettled({ band: 3, status: "due", verdict: null });
    expect((await score()).points.total).toBe(15 - 50 + 5 + 32);
  });

  it("AC-020.1: savings tiles count wins only, with net time subtracting 30 s for every bet not undone", async () => {
    await setup();
    const plants = loadSavings().plants;
    seedSettled({ band: 3, verdict: "win" });
    seedSettled({ band: 3, verdict: "win" });
    seedSettled({ band: 3, verdict: "small_loss" });
    seedSettled({ kind: "do_it", band: 3, verdict: "weather_would_have", points: -10 });
    seedSettled({ band: 3, status: "undone", verdict: null });
    const { savings } = await score();
    expect(savings.wins).toBe(2);
    expect(savings.bets).toBe(4);
    expect(savings.time_saved_s).toBe(Math.round(plants.time_min * 2 * 60));
    expect(savings.app_time_s).toBe(4 * 30);
    expect(savings.net_time_s).toBe(savings.time_saved_s - 120);
    expect(savings.water_l).toBeCloseTo(plants.water_l * 2, 5);
    expect(savings.electricity_kwh).toBeCloseTo(plants.electricity_kwh * 2, 5);
    expect(savings.assumptions).toEqual([
      expect.objectContaining({ chore_type: "plants", assumption: plants.assumption, wins: 2 }),
    ]);
  });

  it("AC-020.1: the judge overrule rate says 'appeals off' while the appeals flag is off", async () => {
    await setup();
    seedSettled({ band: 3, verdict: "win" });
    expect((await score()).judge).toEqual({ appeals: "off" });
  });

  it("AC-020.1: with appeals on, the overrule rate is the appeals that changed a verdict over the judged bets, with N", async () => {
    await setup({ flags: { score: true, appeals: true } });
    expect((await score()).judge).toEqual({ appeals: "on", n: 0, overruled: 0, rate_pct: null });
    const changed = seedSettled({ band: 3, verdict: "small_loss", points: -25 });
    const same = seedSettled({ band: 3, verdict: "normal_loss", points: -50 });
    seedSettled({ band: 3, verdict: "win" });
    seedSettled({ band: 3, verdict: "win" });
    // Do-it decisions have no appeal and are not judged bets for this rate.
    seedSettled({ kind: "do_it", band: 3 });
    harness.db
      .prepare("UPDATE settlements SET final = 0 WHERE bet_id IN (?, ?)")
      .run(changed, same);
    const originalOf = (betId: number): number =>
      harness.db
        .prepare<[number], { id: number }>("SELECT id FROM settlements WHERE bet_id = ?")
        .get(betId)!.id;
    insertSettlement(changed, "win", 15, { appealOf: originalOf(changed) });
    insertSettlement(same, "normal_loss", -50, { appealOf: originalOf(same) });
    expect((await score()).judge).toEqual({ appeals: "on", n: 4, overruled: 1, rate_pct: 25 });
  });

  it("AC-020.2: Gemma's chart counts settled do-nothing bets priced by Gemma under Gemma's band; the rule's counts every one under its own band", async () => {
    await setup();
    // Gemma priced band 4 and the rule said band 2; the win counts in both charts, once each.
    seedSettled({ band: 4, ruleBand: 2, verdict: "win" });
    seedSettled({ band: 4, ruleBand: 2, verdict: "small_loss" });
    // Rule-priced bet (Gemma offline): rule chart only.
    seedSettled({ band: 2, source: "rule", verdict: "win" });
    // Fixtures of the fake model are not Gemma: rule chart only.
    seedSettled({ band: 4, ruleBand: 3, modelVersion: "fake-gemma", verdict: "win" });
    const { calibration } = await score();
    const gemma = calibration.gemma;
    expect(gemma.map((entry) => entry.n)).toEqual([0, 0, 0, 0, 2]);
    expect(gemma[4]).toMatchObject({ band: 4, predicted_pct: 85, wins: 1, actual_pct: 50 });
    const rule = calibration.rule;
    expect(rule.map((entry) => entry.n)).toEqual([0, 0, 3, 1, 0]);
    expect(rule[2]).toMatchObject({ band: 2, predicted_pct: 50, wins: 2, actual_pct: 67 });
    expect(rule[3]).toMatchObject({ wins: 1, actual_pct: 100 });
    expect(calibration.settled).toBe(4);
  });

  it("AC-020.2: do-it decisions, cash-outs, undone and unsettled bets are in neither chart", async () => {
    await setup();
    seedSettled({ kind: "do_it", band: 3, verdict: "weather_would_have", points: -10 });
    seedSettled({ band: 3, status: "cashed_out", verdict: null });
    seedSettled({ band: 3, status: "undone", verdict: null });
    seedSettled({ band: 3, status: "awaiting_gemma", verdict: null });
    seedSettled({ band: 3, status: "open", verdict: null });
    const { calibration } = await score();
    expect(calibration.settled).toBe(0);
    for (const chart of [calibration.gemma, calibration.rule]) {
      expect(chart.every((entry) => entry.n === 0 && entry.actual_pct === null)).toBe(true);
    }
  });

  it("AC-020.2: every win is a success, lucky wins included, and the lucky share is reported separately", async () => {
    await setup();
    seedSettled({ band: 0, verdict: "win", luckyWin: 1 });
    seedSettled({ band: 0, verdict: "win", luckyWin: 0 });
    seedSettled({ band: 0, verdict: "win", luckyWin: null });
    seedSettled({ band: 0, verdict: "harmful_loss", points: -150 });
    const { calibration } = await score();
    expect(calibration.gemma[0]).toMatchObject({ n: 4, wins: 3, actual_pct: 75 });
    expect(calibration.rule[0]).toMatchObject({ n: 4, wins: 3 });
    // The unlabelled win is left out of the share, not counted as lucky or as not lucky.
    expect(calibration.lucky_wins).toEqual({ wins_labelled: 2, lucky_wins: 1, share: 0.5 });
  });

  it("AC-020.2: the final verdict of an appealed bet is the one counted", async () => {
    await setup();
    const bet = seedSettled({ band: 3, verdict: "small_loss", points: -25 });
    const first = harness.db
      .prepare<[number], { id: number }>("SELECT id FROM settlements WHERE bet_id = ?")
      .get(bet)!.id;
    harness.db.prepare("UPDATE settlements SET final = 0 WHERE id = ?").run(first);
    insertSettlement(bet, "win", 15, { appealOf: first });
    const { calibration } = await score();
    expect(calibration.gemma[3]).toMatchObject({ n: 1, wins: 1 });
  });

  it(`AC-020.3: a band with fewer than ${MIN_BETS_PER_BAND} settled bets shows its N and is marked too few to judge`, async () => {
    await setup();
    for (let i = 0; i < MIN_BETS_PER_BAND - 1; i += 1) {
      seedSettled({ band: 1, ruleBand: 1, verdict: "win" });
    }
    for (let i = 0; i < MIN_BETS_PER_BAND; i += 1) {
      seedSettled({ band: 3, ruleBand: 3, verdict: i < 4 ? "win" : "small_loss" });
    }
    const { gemma } = (await score()).calibration;
    expect(gemma[1]).toMatchObject({ n: 4, too_few: true });
    expect(gemma[3]).toMatchObject({ n: 5, too_few: false, actual_pct: 80 });
    // A band nobody bet on has N = 0 and is also too few.
    expect(gemma[0]).toMatchObject({ n: 0, too_few: true, actual_pct: null });
  });

  it("AC-020.4: with no settled bets the counts are zero, which the screen shows as its empty state", async () => {
    await setup();
    const body = await score();
    expect(body.calibration.settled).toBe(0);
    expect(body.points.total).toBe(0);
    expect(body.calibration.lucky_wins.share).toBeNull();
  });

  it("AC-020.1, AC-020.2: a bet placed and settled through the app shows up in points, savings and both charts", async () => {
    await setup({ weatherProfile: FAKE_WEATHER_PROFILES.rainy });
    const betId = seedBet(harness, { band: 3 });
    const settled = await tap(harness, betId, "moist");
    expect(settled.body.state).toBe("settled");
    const body = await score();
    // The screen's schema accepts exactly what the server sends.
    expect(scoreSchema.safeParse(body).success).toBe(true);
    expect(body.points.total).toBe(settled.body.receipt!.points);
    expect(body.savings.wins).toBe(settled.body.receipt!.verdict === "win" ? 1 : 0);
    expect(body.calibration.settled).toBe(1);
    // A rule-priced bet is in the rule's chart and not in Gemma's.
    expect(body.calibration.rule[3]!.n).toBe(1);
    expect(body.calibration.gemma.every((entry) => entry.n === 0)).toBe(true);
  });
});
