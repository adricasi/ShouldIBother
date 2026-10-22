import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";
import { SCHEDULER_INTERVAL_MS, createScheduler } from "../src/server/scheduler.js";

import { FakeClock } from "./helpers.js";

let db: Db;
const clock = new FakeClock();

function seedBet(settleAt: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO cards (id, input_text, chore_type, kind, created_at) VALUES (1, 'x', 'plants', 'weather', 1)",
  ).run();
  db.prepare(
    `INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at,
       undo_until, settle_at, status) VALUES (1, 'do_nothing', 2, 50, 'rule', 'r', 2, 1, 2, ?, 'open')`,
  ).run(settleAt);
}

const statuses = (): string[] =>
  (db.prepare("SELECT status FROM bets ORDER BY id").all() as { status: string }[]).map(
    (row) => row.status,
  );

beforeEach(() => {
  vi.useFakeTimers();
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS);
  clock.current = Date.UTC(2026, 9, 22, 8, 0);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("scheduler loop (design: every 60 s, all state in SQLite)", () => {
  it("marks due at start, then every 60 s, and stops on stop()", () => {
    seedBet(clock.current - 1); // already past: the first pass at start-up marks it due
    const scheduler = createScheduler({ db, now: clock.now }, () => undefined);
    scheduler.start();
    expect(statuses()).toEqual(["due"]);

    db.prepare("DELETE FROM bets").run();
    seedBet(clock.current + 90_000);
    clock.advance(SCHEDULER_INTERVAL_MS);
    vi.advanceTimersByTime(SCHEDULER_INTERVAL_MS);
    expect(statuses()).toEqual(["open"]); // 60 s later it is not yet due
    clock.advance(SCHEDULER_INTERVAL_MS);
    vi.advanceTimersByTime(SCHEDULER_INTERVAL_MS);
    expect(statuses()).toEqual(["due"]);

    scheduler.stop();
    db.prepare("DELETE FROM bets").run();
    seedBet(clock.current - 1);
    vi.advanceTimersByTime(10 * SCHEDULER_INTERVAL_MS);
    expect(statuses()).toEqual(["open"]);
  });

  it("start twice runs one loop", () => {
    const scheduler = createScheduler({ db, now: clock.now }, () => undefined);
    scheduler.start();
    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a failing pass and keeps looping", () => {
    const errors: unknown[] = [];
    const scheduler = createScheduler({ db, now: clock.now }, (error) => errors.push(error));
    scheduler.start();
    db.exec("DROP TABLE bets");
    vi.advanceTimersByTime(SCHEDULER_INTERVAL_MS);
    expect(errors).toHaveLength(1);
    vi.advanceTimersByTime(SCHEDULER_INTERVAL_MS);
    expect(errors).toHaveLength(2);
    scheduler.stop();
  });
});
