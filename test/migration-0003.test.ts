import { describe, expect, it } from "vitest";

import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

/** Locked for good, even for a write of the same value. */
const LOCKED = [
  "card_id",
  "kind",
  "band",
  "odds",
  "odds_source",
  "reason",
  "gemma_band",
  "rule_band",
  "placed_at",
  "undo_until",
  "settle_at",
] as const;

/** Filled later by their tasks: NULL → value once, then locked. */
const WRITE_ONCE = {
  savings_snapshot: ["'{\"minutes\":5}'", "'{\"minutes\":9}'"],
  model_version: ["'gemma-4-e4b'", "'other'"],
  prompt_version: ["'bookmaker.v1'", "'bookmaker.v2'"],
  band_without_photo: ["3", "4"],
} as const;

/** A different value that is valid for the column's CHECK, so only the trigger can refuse it. */
const CHANGED: Record<(typeof LOCKED)[number], string> = {
  card_id: "2",
  kind: "'do_it'",
  band: "0",
  odds: "15",
  odds_source: "'gemma'",
  reason: "'changed'",
  gemma_band: "4",
  rule_band: "4",
  placed_at: "99",
  undo_until: "99",
  settle_at: "99",
};

function seed(db: Db): void {
  db.exec(`
    INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('a', 'plants', 'weather', 1);
    INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('b', 'plants', 'weather', 1);
    INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
      VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'open');
    INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
      VALUES (2, 'do_nothing', 2, 50, 'rule', 'maybe', 2, 10, 20, 30, 'settled');
    INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at)
      VALUES (2, 'tap', 0.5, 'win', 25, 40);
  `);
}

describe("migration 0003: locked bet columns and the state machine", () => {
  it("is number 3", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual([1, 2, 3]);
  });

  it("NFR-003: applies to a seeded database of 0002 and keeps every row", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS.slice(0, 2));
    seed(db);
    db.prepare(
      "INSERT INTO sessions (id_hash, created_at, expires_at, last_seen_at) VALUES ('h', 1, 2, 1)",
    ).run();
    const before = db.prepare("SELECT * FROM bets ORDER BY id").all();

    expect(migrate(db, MIGRATIONS)).toEqual([3]);

    expect(db.prepare("SELECT * FROM bets ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT id_hash FROM sessions").all()).toEqual([{ id_hash: "h" }]);
    // Running it again is a no-op.
    expect(migrate(db, MIGRATIONS)).toEqual([]);
  });

  it.each(LOCKED)("AC-006.2: the locked column %s cannot be updated after insert", (column) => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    seed(db);
    const before = db.prepare("SELECT * FROM bets WHERE id = 1").get();
    expect(() => db.exec(`UPDATE bets SET ${column} = ${CHANGED[column]} WHERE id = 1`)).toThrow(
      /locked columns/,
    );
    // Even writing the same value back is refused: nothing may touch a locked column.
    expect(() => db.exec(`UPDATE bets SET ${column} = ${column} WHERE id = 1`)).toThrow(
      /locked columns/,
    );
    expect(db.prepare("SELECT * FROM bets WHERE id = 1").get()).toEqual(before);
  });

  it.each(Object.entries(WRITE_ONCE))(
    "AC-006.2: %s may be filled once from NULL, then it is locked",
    (column, [first, second]) => {
      const db = openDatabase(":memory:");
      migrate(db, MIGRATIONS);
      seed(db);
      const value = (): unknown =>
        (db.prepare(`SELECT ${column} AS v FROM bets WHERE id = 1`).get() as { v: unknown }).v;
      expect(value()).toBeNull();
      // NULL → value is allowed once (a bet placed before the filling task existed).
      expect(() => db.exec(`UPDATE bets SET ${column} = ${first} WHERE id = 1`)).not.toThrow();
      const filled = value();
      expect(filled).not.toBeNull();
      // value → other value, value → same value and value → NULL are all refused.
      for (const next of [second, first, "NULL"]) {
        expect(() => db.exec(`UPDATE bets SET ${column} = ${next} WHERE id = 1`)).toThrow(
          /locked columns/,
        );
      }
      expect(value()).toEqual(filled);
    },
  );

  it("AC-006.2: filling one write-once column does not unlock or block the others", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    seed(db);
    db.exec("UPDATE bets SET model_version = 'gemma-4-e4b' WHERE id = 1");
    expect(() =>
      db.exec(
        "UPDATE bets SET prompt_version = 'bookmaker.v1', band_without_photo = 3 WHERE id = 1",
      ),
    ).not.toThrow();
    expect(() => db.exec("UPDATE bets SET prompt_version = 'bookmaker.v2' WHERE id = 1")).toThrow(
      /locked columns/,
    );
    // The core columns were never touched by any of it.
    expect(db.prepare("SELECT band, odds, reason, settle_at FROM bets WHERE id = 1").get()).toEqual(
      {
        band: 3,
        odds: 70,
        reason: "rain",
        settle_at: 30,
      },
    );
  });

  it("AC-006.2: the primary key of a bet cannot be changed either", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    seed(db);
    expect(() => db.exec("UPDATE bets SET id = 50 WHERE id = 1")).toThrow(/locked columns/);
  });

  it("AC-006.2: the status can still move along the machine while the locked columns hold", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    seed(db);
    expect(() => db.exec("UPDATE bets SET status = 'due' WHERE id = 1")).not.toThrow();
    expect(db.prepare("SELECT status, odds, band, reason FROM bets WHERE id = 1").get()).toEqual({
      status: "due",
      odds: 70,
      band: 3,
      reason: "rain",
    });
  });

  it("a settled bet stays settled", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    seed(db);
    expect(() => db.exec("UPDATE bets SET status = 'open' WHERE id = 2")).toThrow(/state machine/);
  });

  it("deleting a card still removes its bets (AC-015.2 groundwork)", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    seed(db);
    db.exec("DELETE FROM cards WHERE id = 1");
    expect(db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 1 });
  });
});
