import { expect } from "vitest";

import type { Band } from "../../src/domain/bands.js";
import { parseFlags } from "../../src/server/flags.js";
import { BackgroundTasks, type LedgerDeps } from "../../src/server/ledger/deps.js";
import { Settler } from "../../src/server/ledger/settle.js";
import { loadAdviceRules } from "../../src/server/advice-rules.js";
import { loadRules } from "../../src/server/rules.js";
import { savingsSnapshotText } from "../../src/server/ledger/savings.js";
import { loadSavings } from "../../src/server/savings.js";
import { EXAMPLE_HOUSEHOLD, type CoreHarness } from "../core-helpers.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

const ODDS = { 0: 15, 1: 35, 2: 50, 3: 70, 4: 85 } as const;

export interface SeedOptions {
  readonly chore?: string;
  readonly kind?: "do_nothing" | "do_it";
  readonly band?: Band;
  readonly status?: string;
  /** Settle time relative to the clock: negative = already passed. */
  readonly settleOffsetMs?: number;
  /** Hours the bet was open before its settle time. */
  readonly openHours?: number;
  readonly withSnapshot?: boolean;
  /** The sunset stored on a laundry-tonight card (`cards.sunset_at`). */
  readonly sunsetAt?: number;
}

/** Inserts a card and a bet straight into the database, at the odds of `band`. Returns the bet id. */
export function seedBet(harness: CoreHarness, options: SeedOptions = {}): number {
  const chore = options.chore ?? "plants";
  const band = options.band ?? 3;
  const settleAt = harness.clock.current + (options.settleOffsetMs ?? -MINUTE);
  const placedAt = settleAt - (options.openHours ?? 20) * HOUR;
  const card = Number(
    harness.db
      .prepare(
        `INSERT INTO cards (input_text, chore_type, kind, sunset_at, created_at)
         VALUES ('seed', ?, 'weather', ?, ?)`,
      )
      .run(chore, options.sunsetAt ?? null, placedAt).lastInsertRowid,
  );
  const snapshot =
    options.withSnapshot === false
      ? null
      : savingsSnapshotText(
          { db: harness.db, household: EXAMPLE_HOUSEHOLD, savings: loadSavings() },
          chore,
        );
  return Number(
    harness.db
      .prepare(
        `INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, savings_snapshot,
           placed_at, undo_until, settle_at, status)
         VALUES (?, ?, ?, ?, 'rule', 'seed', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card,
        options.kind ?? "do_nothing",
        band,
        ODDS[band],
        band,
        snapshot,
        placedAt,
        placedAt + 5 * MINUTE,
        settleAt,
        options.status ?? "due",
      ).lastInsertRowid,
  );
}

export interface JudgeCall {
  readonly user: string;
  readonly images: number;
  readonly data: Record<string, unknown>;
}

/** The judge calls the fake model saw, with the delimited data block parsed. */
export function judgeCalls(harness: CoreHarness): JudgeCall[] {
  return harness.model.calls
    .filter((call) => call.job === "judge")
    .map((call) => {
      const user = call.messages.find((message) => message.role === "user")?.content ?? "";
      const json = /<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/.exec(user)?.[1] ?? "{}";
      return {
        user,
        images: call.images?.length ?? 0,
        data: JSON.parse(json) as Record<string, unknown>,
      };
    });
}

export interface SettleBody {
  state: "settled" | "question" | "awaiting_weather" | "awaiting_gemma";
  question?: string;
  note?: string;
  receipt?: {
    bet_id: number;
    title: string;
    kind: string;
    outcome: string;
    verdict: string;
    verdict_title: string;
    stamp: string | null;
    odds: number;
    points: number;
    total_points: number;
    multiplier: number;
    evidence: { kind: string; text: string };
    answer: string | null;
    weather: { label: string; digest: Record<string, number | null> } | null;
    gemma_read: { reason: string; evidence: string[] } | null;
    lucky_win: boolean | null;
    message: string | null;
    saved: {
      time_min: number;
      water_l: number;
      electricity_kwh: number;
      assumption: string;
      basis: string;
    } | null;
  };
}

export async function tap(
  harness: CoreHarness,
  betId: number,
  answer: string,
): Promise<{ status: number; body: SettleBody }> {
  const response = await harness.post(`/api/bets/${betId}/settle`, { answer });
  return { status: response.statusCode, body: response.json<SettleBody>() };
}

export function settlementOf(harness: CoreHarness, betId: number): Record<string, unknown> {
  const row = harness.db
    .prepare<[number], Record<string, unknown>>("SELECT * FROM settlements WHERE bet_id = ?")
    .get(betId);
  expect(row).toBeDefined();
  return row!;
}

export function statusOf(harness: CoreHarness, betId: number): string {
  return harness.db
    .prepare<[number], { status: string }>("SELECT status FROM bets WHERE id = ?")
    .get(betId)!.status;
}

export function settlementCount(harness: CoreHarness): number {
  return harness.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM settlements").get()!.n;
}

/** A second Settler on the harness's database and Gemma queue, with its log lines captured. */
export function makeSettler(harness: CoreHarness): {
  settler: Settler;
  logs: Record<string, unknown>[];
  deps: LedgerDeps;
} {
  const logs: Record<string, unknown>[] = [];
  const deps: LedgerDeps = {
    db: harness.db,
    now: harness.clock.now,
    weather: harness.weather,
    gemma: harness.core.gemma,
    rules: loadRules(),
    adviceRules: loadAdviceRules(),
    household: EXAMPLE_HOUSEHOLD,
    flags: parseFlags({}),
    savings: loadSavings(),
    photos: harness.photos,
    background: new BackgroundTasks(() => undefined),
    log: (entry) => logs.push({ ...entry }),
  };
  return { settler: new Settler(deps), logs, deps };
}
