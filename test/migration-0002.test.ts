import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const tables = (db: ReturnType<typeof openDatabase>): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

describe("migration 0002: core schema", () => {
  it("is number 2 and creates the design's tables", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual([1, 2]);
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        "cards",
        "quotes",
        "bets",
        "settlements",
        "photos",
        "gemma_decisions",
        "weather_cache",
      ]),
    );
    const columns = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("gemma_decisions")).toEqual(
      expect.arrayContaining(["card_id", "bet_id", "photo_id", "tool_mode", "model_digest"]),
    );
    expect(columns("bets")).toEqual(
      expect.arrayContaining([
        "odds_source",
        "gemma_band",
        "rule_band",
        "band_without_photo",
        "undo_until",
      ]),
    );
  });

  it("NFR-003: keeps the rows of 0001 (a seeded database with a paired phone)", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS.slice(0, 1));
    db.prepare(
      "INSERT INTO sessions (id_hash, created_at, expires_at, last_seen_at) VALUES ('h', 1, 2, 1)",
    ).run();
    db.prepare("INSERT INTO pairing (token_hash, created_at, expires_at) VALUES ('t', 1, 2)").run();
    expect(migrate(db, MIGRATIONS)).toEqual([2]);
    expect(db.prepare("SELECT id_hash FROM sessions").all()).toEqual([{ id_hash: "h" }]);
    expect(db.prepare("SELECT token_hash FROM pairing").all()).toEqual([{ token_hash: "t" }]);
  });

  it("only accepts odds from the fixed table and bands 0 to 4", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    db.prepare(
      "INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('x', 'plants', 'weather', 1)",
    ).run();
    const insertBet = (band: number, odds: number): void => {
      db.prepare(
        `INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at,
           undo_until, settle_at) VALUES (1, 'do_nothing', ?, ?, 'rule', 'r', 2, 1, 2, 3)`,
      ).run(band, odds);
    };
    expect(() => insertBet(2, 50)).not.toThrow();
    expect(() => insertBet(5, 50)).toThrow();
    expect(() => insertBet(2, 51)).toThrow();
  });

  it("removes a card's quotes, bets, settlements and decisions with it (AC-015.2 groundwork)", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    db.exec(`
      INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('x', 'plants', 'weather', 1);
      INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at) VALUES (1, 'rule', 2, 50, 'r', 3, 1);
      INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at)
        VALUES (1, 'do_nothing', 2, 50, 'rule', 'r', 2, 1, 2, 3);
      INSERT INTO gemma_decisions (job, card_id, bet_id, model, prompt_version, valid, latency_ms, created_at)
        VALUES ('judge', 1, 1, 'fake', 'judge.v1', 1, 5, 4);
      INSERT INTO settlements (bet_id, evidence, multiplier, verdict, decision_id, points, settled_at)
        VALUES (1, 'tap', 0.5, 'win', 1, 25, 4);
    `);
    db.prepare("DELETE FROM cards WHERE id = 1").run();
    for (const table of ["quotes", "bets", "gemma_decisions", "settlements"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});
