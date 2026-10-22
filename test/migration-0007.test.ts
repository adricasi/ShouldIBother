import { describe, expect, it } from "vitest";

import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const BEFORE = MIGRATIONS.filter((migration) => migration.id < 7);

/**
 * A database as the live week leaves it at migration 0006: open and due bets (one with no
 * savings snapshot, like Thursday's first real bets), a settled one, quotes and decisions.
 */
function seedLiveDatabase(db: Db): void {
  migrate(db, BEFORE);
  db.exec(`
    INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES
      ('Water plants', 'plants', 'weather', 1), ('Water plants', 'plants', 'weather', 2),
      ('Line-dry', 'laundry_line', 'weather', 3);
    INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at)
      VALUES (1, 'rule', 3, 70, 'rain', 30, 1), (2, 'rule', 1, 35, 'dry', 40, 2);
    INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
      VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'open'),
             (2, 'do_nothing', 1, 35, 'rule', 'dry', 1, 11, 21, 31, 'due'),
             (3, 'do_nothing', 2, 50, 'rule', 'sun', 2, 12, 22, 32, 'awaiting_gemma');
    INSERT INTO gemma_decisions (job, card_id, model, prompt_version, valid, latency_ms, created_at)
      VALUES ('bookmaker', 1, 'm', 'bookmaker.v1', 1, 5, 12);
  `);
}

describe("migration 0007: what a bet knows while it settles (NFR-003)", () => {
  it("is number 7", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toContain(7);
  });

  it("keeps every open, due and waiting bet, quote and decision, and adds only a table", () => {
    const db = openDatabase(":memory:");
    seedLiveDatabase(db);
    const betsBefore = db.prepare("SELECT * FROM bets ORDER BY id").all();
    const cardsBefore = db.prepare("SELECT * FROM cards ORDER BY id").all();
    expect(migrate(db, MIGRATIONS)).toEqual([7]);
    expect(db.prepare("SELECT * FROM bets ORDER BY id").all()).toEqual(betsBefore);
    expect(db.prepare("SELECT * FROM cards ORDER BY id").all()).toEqual(cardsBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM quotes").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gemma_decisions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settle_progress").get()).toEqual({ n: 0 });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(migrate(db, MIGRATIONS)).toEqual([]);
    db.close();
  });

  it("settles the seeded open bets with the bet triggers of migration 0003 still in force", () => {
    const db = openDatabase(":memory:");
    seedLiveDatabase(db);
    migrate(db, MIGRATIONS);
    // The machine's arrows are unchanged: due and awaiting_gemma bets settle, open ones do not.
    db.prepare("UPDATE bets SET status = 'settled' WHERE id IN (2, 3)").run();
    expect(() => db.prepare("UPDATE bets SET status = 'settled' WHERE id = 1").run()).toThrow(
      /state machine/,
    );
    expect(() => db.prepare("UPDATE bets SET odds = 85 WHERE id = 1").run()).toThrow(
      /cannot be updated/,
    );
    // A NULL savings snapshot can be filled once (the backfill), then never again.
    db.prepare("UPDATE bets SET savings_snapshot = '{}' WHERE id = 1").run();
    expect(() =>
      db.prepare("UPDATE bets SET savings_snapshot = '{\"a\":1}' WHERE id = 1").run(),
    ).toThrow(/cannot be updated/);
    db.close();
  });

  it("stores an answer, refuses a half-filled one and drops it with its bet or its after photo", () => {
    const db = openDatabase(":memory:");
    seedLiveDatabase(db);
    migrate(db, MIGRATIONS);
    db.exec(`
      INSERT INTO photos (id, bet_id, role, file, received_at, width, height)
        VALUES ('11111111-1111-4111-8111-111111111111', 1, 'after', 'a.jpg', 5, 10, 10);
      INSERT INTO photos (id, card_id, role, file, received_at, width, height)
        VALUES ('22222222-2222-4222-8222-222222222222', 1, 'before', 'b.jpg', 4, 10, 10);
    `);
    db.prepare(
      "INSERT INTO settle_progress (bet_id, evidence, answer_id, answered_at) VALUES (2, 'tap', 'moist', 5)",
    ).run();
    expect(() =>
      db
        .prepare("INSERT INTO settle_progress (bet_id, evidence, answered_at) VALUES (3, 'tap', 5)")
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO settle_progress (bet_id, evidence, answer_id, photo_id, answered_at) VALUES (3, 'photo', 'x', '11111111-1111-4111-8111-111111111111', 5)",
        )
        .run(),
    ).toThrow();
    db.prepare(
      `INSERT INTO settle_progress (bet_id, evidence, photo_id, before_photo_id, answered_at)
       VALUES (1, 'photo', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 5)`,
    ).run();
    // The before photo may go without losing the answer; the after photo takes it along.
    db.prepare("DELETE FROM photos WHERE id = '22222222-2222-4222-8222-222222222222'").run();
    expect(
      db.prepare("SELECT before_photo_id FROM settle_progress WHERE bet_id = 1").get(),
    ).toEqual({
      before_photo_id: null,
    });
    db.prepare("DELETE FROM photos WHERE id = '11111111-1111-4111-8111-111111111111'").run();
    expect(db.prepare("SELECT bet_id FROM settle_progress").all()).toEqual([{ bet_id: 2 }]);
    db.prepare("DELETE FROM bets WHERE id = 2").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM settle_progress").get()).toEqual({ n: 0 });
    db.close();
  });
});
