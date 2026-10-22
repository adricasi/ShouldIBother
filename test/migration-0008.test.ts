import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

describe("migration 0008: the sunset a laundry card was priced on and its safety verdict (NFR-003)", () => {
  it("is number 8", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toContain(8);
  });

  it("adds two nullable columns and keeps existing cards, quotes and bets", () => {
    const db = openDatabase(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.id < 8),
    );
    db.exec(`
      INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 1);
      INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at)
        VALUES (1, 'rule', 3, 70, 'rain', 30, 1);
      INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
        VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'open');
    `);
    const before = db.prepare("SELECT * FROM cards").all();
    expect(migrate(db, MIGRATIONS)).toEqual(expect.arrayContaining([8]));
    expect(db.prepare("SELECT * FROM cards").all()).toEqual(
      before.map((card) => ({
        ...(card as object),
        sunset_at: null,
        safety_checked_at: null,
        plan: null,
        advice_followed_at: null,
        advice_points: null,
      })),
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 1 });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrate(db, MIGRATIONS)).toEqual([]);
    db.close();
  });

  it("makes sunset_at write-once but leaves safety_checked_at free to be set", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    db.exec(
      `INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('x', 'laundry_tonight', 'weather', 1)`,
    );
    db.prepare("UPDATE cards SET sunset_at = 100 WHERE id = 1").run();
    expect(() => db.prepare("UPDATE cards SET sunset_at = 200 WHERE id = 1").run()).toThrow(
      /sunset_at cannot be updated/,
    );
    db.prepare("UPDATE cards SET safety_checked_at = 5 WHERE id = 1").run();
    expect(db.prepare("SELECT sunset_at, safety_checked_at FROM cards").get()).toEqual({
      sunset_at: 100,
      safety_checked_at: 5,
    });
    db.close();
  });

  it("lets a bet go from open to undone, the one arrow the safety guard's withdrawal uses", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    db.exec(`
      INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('x', 'plants', 'weather', 1), ('y', 'plants', 'weather', 2);
      INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
        VALUES (1, 'do_nothing', 3, 70, 'rule', 'r', 3, 10, 20, 30, 'open'), (2, 'do_nothing', 3, 70, 'rule', 'r', 3, 10, 20, 30, 'due');
    `);
    db.prepare("UPDATE bets SET status = 'undone' WHERE id = 1").run();
    // A bet that is already due cannot be withdrawn: the state machine does not allow it.
    expect(() => db.prepare("UPDATE bets SET status = 'undone' WHERE id = 2").run()).toThrow();
    db.close();
  });
});
