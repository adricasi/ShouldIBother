import { describe, expect, it } from "vitest";

import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const BEFORE = MIGRATIONS.filter((migration) => migration.id < 4);

/** A database as the live week leaves it at migration 0003: cards with bets, quotes and an alert. */
function seedLiveDatabase(db: Db): void {
  migrate(db, BEFORE);
  db.exec(`
    INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 1);
    INSERT INTO cards (input_text, chore_type, kind, alert_reason, created_at) VALUES ('Water plants', 'plants', 'alert', 'Heat', 2);
    INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at)
      VALUES (1, 'rule', 3, 70, 'rain', 30, 1);
    INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
      VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'open');
  `);
}

describe("migration 0004: cards can carry a notice (NFR-003)", () => {
  it("keeps every existing card, quote and open bet", () => {
    const db = openDatabase(":memory:");
    seedLiveDatabase(db);
    expect(migrate(db, MIGRATIONS.slice(0, 4))).toEqual([4]);
    expect(
      db.prepare("SELECT id, kind, alert_reason, notice FROM cards ORDER BY id").all(),
    ).toEqual([
      { id: 1, kind: "weather", alert_reason: null, notice: null },
      { id: 2, kind: "alert", alert_reason: "Heat", notice: null },
    ]);
    expect(db.prepare("SELECT status FROM bets").all()).toEqual([{ status: "open" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM quotes").get()).toEqual({ n: 1 });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("stores a notice on a coming_later card, and deleting a card still cascades", () => {
    const db = openDatabase(":memory:");
    seedLiveDatabase(db);
    migrate(db, MIGRATIONS);
    db.prepare(
      "INSERT INTO cards (input_text, chore_type, kind, notice, created_at) VALUES ('x', 'ac', 'coming_later', 'Not needed this season', 3)",
    ).run();
    expect(db.prepare("SELECT notice FROM cards WHERE id = 3").get()).toEqual({
      notice: "Not needed this season",
    });
    db.prepare("DELETE FROM cards WHERE id = 1").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM bets").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM quotes").get()).toEqual({ n: 0 });
    db.close();
  });
});
