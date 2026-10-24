import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const upTo18 = MIGRATIONS.filter((migration) => migration.id <= 18);
const upTo19 = MIGRATIONS.filter((migration) => migration.id <= 19);

describe("migration 0019: the hosted daily model-call counter (AC-032.5, NFR-003)", () => {
  it("is number 19, after 0018", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids).toContain(19);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("adds one table and keeps a seeded database untouched", () => {
    const db = openDatabase(":memory:");
    migrate(db, upTo18);
    db.exec(`
      INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 1);
      INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at)
        VALUES (1, 'rule', 3, 70, 'rain', 30, 1);
      INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
        VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'open');
    `);
    const before = {
      cards: db.prepare("SELECT * FROM cards").all(),
      quotes: db.prepare("SELECT * FROM quotes").all(),
      bets: db.prepare("SELECT * FROM bets").all(),
    };
    expect(migrate(db, upTo19)).toEqual([19]);
    expect({
      cards: db.prepare("SELECT * FROM cards").all(),
      quotes: db.prepare("SELECT * FROM quotes").all(),
      bets: db.prepare("SELECT * FROM bets").all(),
    }).toEqual(before);
    const columns = db.prepare("PRAGMA table_info(model_calls)").all() as {
      name: string;
      pk: number;
    }[];
    expect(columns.map((column) => column.name)).toEqual(["day", "calls", "judge_calls"]);
    expect(columns.find((column) => column.name === "day")?.pk).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_calls").get()).toEqual({ n: 0 });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(migrate(db, upTo19)).toEqual([]);
    db.close();
  });

  it("refuses a negative count", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    expect(() =>
      db.prepare("INSERT INTO model_calls (day, calls) VALUES ('2026-10-23', -1)").run(),
    ).toThrow();
    db.close();
  });
});
