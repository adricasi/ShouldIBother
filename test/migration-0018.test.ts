import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const upTo17 = MIGRATIONS.filter((migration) => migration.id <= 17);
const upTo18 = MIGRATIONS.filter((migration) => migration.id <= 18);

describe("migration 0018: the advice card's state on its card (NFR-003)", () => {
  it("is number 18, after 0016 and 0017 of T-035", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids).toContain(18);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("adds one nullable column to cards and keeps a seeded database untouched", () => {
    const db = openDatabase(":memory:");
    migrate(db, upTo17);
    db.exec(`
      INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 1);
      INSERT INTO cards (input_text, chore_type, kind, notice, created_at) VALUES ('clean the windows', 'windows_clean', 'coming_later', 'Coming later', 2);
      INSERT INTO cards (input_text, chore_type, kind, plan, created_at) VALUES ('wash', 'laundry_plan', 'coming_later', '{"version":1}', 3);
      INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at)
        VALUES (1, 'rule', 3, 70, 'rain', 30, 1);
      INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
        VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'open');
    `);
    const cardsBefore = db.prepare("SELECT * FROM cards ORDER BY id").all();
    const quotesBefore = db.prepare("SELECT * FROM quotes").all();
    const betsBefore = db.prepare("SELECT * FROM bets").all();
    expect(migrate(db, upTo18)).toEqual([18]);
    expect(db.prepare("SELECT * FROM cards ORDER BY id").all()).toEqual(
      cardsBefore.map((card) => ({ ...(card as object), advice: null })),
    );
    expect(db.prepare("SELECT * FROM quotes").all()).toEqual(quotesBefore);
    expect(db.prepare("SELECT * FROM bets").all()).toEqual(betsBefore);
    const columns = db.prepare("PRAGMA table_info(cards)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    expect(columns.find((column) => column.name === "advice")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(migrate(db, upTo18)).toEqual([]);
    db.close();
  });

  it("reads back the advice JSON written to a card", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    db.exec(
      `INSERT INTO cards (input_text, chore_type, kind, advice, created_at)
       VALUES ('clean the windows', 'windows_clean', 'weather', '{"version":1}', 1)`,
    );
    expect(db.prepare("SELECT advice FROM cards").get()).toEqual({ advice: '{"version":1}' });
    db.close();
  });
});
