import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const upTo10 = MIGRATIONS.filter((migration) => migration.id <= 10);

function seed(db: ReturnType<typeof openDatabase>): void {
  db.exec(`
    INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 1);
    INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
      VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'settled');
    INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
      VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'undone');
    INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at, appeal_of, final)
      VALUES (1, 'tap', 0.5, 'win', 15, 40, NULL, 1);
  `);
}

const insertAppeal = (db: ReturnType<typeof openDatabase>, betId: number, appealOf: number) =>
  db
    .prepare(
      `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at, appeal_of, final)
       VALUES (?, 'photo', 1, 'normal_loss', -50, 50, ?, 1)`,
    )
    .run(betId, appealOf);

describe("migration 0012: the rules behind appeals (REQ-023)", () => {
  it("is number 12, after 11, and applies to a database that already holds settlements without rewriting them", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids).toContain(12);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const db = openDatabase(":memory:");
    migrate(db, upTo10);
    seed(db);
    const before = db.prepare("SELECT * FROM settlements").all();
    expect(migrate(db, MIGRATIONS)).toEqual(ids.filter((id) => id > 10));
    expect(db.prepare("SELECT * FROM settlements").all()).toEqual(before);
    db.close();
  });

  it("AC-023.2: one appeal per bet, one final row per bet, and an appeal follows an original of its own bet", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    seed(db);
    // The first row stops being final before the appeal is inserted.
    expect(() => insertAppeal(db, 1, 1)).toThrow(/UNIQUE/);
    db.prepare("UPDATE settlements SET final = 0 WHERE id = 1").run();
    expect(() => insertAppeal(db, 1, 1)).not.toThrow();
    // A second appeal, even a non-final one, is refused.
    expect(() =>
      db
        .prepare(
          `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at, appeal_of, final)
           VALUES (1, 'photo', 1, 'win', 30, 60, 1, 0)`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE bet_id = 1").get()).toEqual({
      n: 2,
    });
    db.close();
  });

  it("an appeal row must point at an original settlement of the same bet", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    seed(db);
    db.prepare("UPDATE settlements SET final = 0 WHERE id = 1").run();
    // Bet 2 has no settlement of its own: it cannot appeal bet 1's.
    expect(() => insertAppeal(db, 2, 1)).toThrow(/follow the original/);
    expect(() => insertAppeal(db, 1, 999)).toThrow(/follow the original/);
    insertAppeal(db, 1, 1);
    // Bet 2 settled on its own (id 3) can be appealed; an appeal is never itself appealed.
    db.exec(`
      INSERT INTO settlements (bet_id, evidence, multiplier, verdict, points, settled_at, appeal_of, final)
        VALUES (2, 'tap', 0.5, 'win', 15, 40, NULL, 0);
    `);
    expect(() => insertAppeal(db, 2, 2)).toThrow(/follow the original/);
    expect(() => insertAppeal(db, 2, 3)).not.toThrow();
    db.close();
  });
});
