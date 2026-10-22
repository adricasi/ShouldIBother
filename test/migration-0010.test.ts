import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const upTo8 = MIGRATIONS.filter((migration) => migration.id <= 8);

describe("migration 0010: the laundry planner's plan and advice points on its card (NFR-003)", () => {
  it("is number 10; the gap at 9 is tolerated because ids only have to increase", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids).toContain(10);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // A database at migration 8 takes 10 even though 9 is not (yet) in the list.
    const db = openDatabase(":memory:");
    migrate(db, upTo8);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.id <= 10),
      ),
    ).toContain(10);
    db.close();
  });

  it("adds three nullable columns to cards and keeps existing cards, quotes and bets untouched", () => {
    const db = openDatabase(":memory:");
    migrate(db, upTo8);
    db.exec(`
      INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 1);
      INSERT INTO cards (input_text, chore_type, kind, notice, created_at) VALUES ('wash', 'laundry_plan', 'coming_later', 'Coming later', 2);
      INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at)
        VALUES (1, 'rule', 3, 70, 'rain', 30, 1);
      INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
        VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'open');
    `);
    const cardsBefore = db.prepare("SELECT * FROM cards ORDER BY id").all();
    const quotesBefore = db.prepare("SELECT * FROM quotes").all();
    const betsBefore = db.prepare("SELECT * FROM bets").all();
    expect(
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.id <= 10),
      ),
    ).toEqual([10]);
    expect(db.prepare("SELECT * FROM cards ORDER BY id").all()).toEqual(
      cardsBefore.map((card) => ({
        ...(card as object),
        plan: null,
        advice_followed_at: null,
        advice_points: null,
      })),
    );
    expect(db.prepare("SELECT * FROM quotes").all()).toEqual(quotesBefore);
    expect(db.prepare("SELECT * FROM bets").all()).toEqual(betsBefore);
    const columns = db.prepare("PRAGMA table_info(cards)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    for (const name of ["plan", "advice_followed_at", "advice_points"]) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        notnull: 0,
        dflt_value: null,
      });
    }
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.id <= 10),
      ),
    ).toEqual([]);
    db.close();
  });

  it("lets the plan and the advice points be written and read back", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    db.exec(
      `INSERT INTO cards (input_text, chore_type, kind, plan, advice_followed_at, advice_points, created_at)
       VALUES ('x', 'laundry_plan', 'coming_later', '{"version":1}', 5, 5, 1)`,
    );
    expect(db.prepare("SELECT plan, advice_followed_at, advice_points FROM cards").get()).toEqual({
      plan: '{"version":1}',
      advice_followed_at: 5,
      advice_points: 5,
    });
    db.close();
  });
});
