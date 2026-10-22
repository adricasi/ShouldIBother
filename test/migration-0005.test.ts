import { describe, expect, it } from "vitest";

import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const BEFORE = MIGRATIONS.filter((migration) => migration.id < 5);

/** A database as the live week leaves it at migration 0004: an open bet and a card with rule odds. */
function seedLiveDatabase(db: Db): void {
  migrate(db, BEFORE);
  db.exec(`
    INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 1);
    INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 2);
    INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at)
      VALUES (1, 'rule', 3, 70, 'rain', 30, 1), (2, 'rule', 1, 35, 'dry', 40, 2);
    INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
      VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'open');
    INSERT INTO gemma_decisions (job, card_id, model, prompt_version, valid, latency_ms, created_at)
      VALUES ('judge', 1, 'm', 'judge.v1', 1, 5, 12);
  `);
}

describe("migration 0005: where a card stands with Gemma (NFR-003)", () => {
  it("is number 5", () => {
    expect(MIGRATIONS.map((migration) => migration.id).at(-1)).toBe(5);
  });

  it("keeps every existing card, quote, decision and open bet; old cards have no stored state", () => {
    const db = openDatabase(":memory:");
    seedLiveDatabase(db);
    const betsBefore = db.prepare("SELECT * FROM bets").all();
    expect(migrate(db, MIGRATIONS)).toEqual([5]);
    expect(
      db
        .prepare(
          "SELECT id, input_text, gemma_state, gemma_failure, gemma_question, gemma_answers FROM cards ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: 1,
        input_text: "Water plants",
        gemma_state: null,
        gemma_failure: null,
        gemma_question: null,
        gemma_answers: "[]",
      },
      {
        id: 2,
        input_text: "Water plants",
        gemma_state: null,
        gemma_failure: null,
        gemma_question: null,
        gemma_answers: "[]",
      },
    ]);
    expect(db.prepare("SELECT * FROM bets").all()).toEqual(betsBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM quotes").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gemma_decisions").get()).toEqual({ n: 1 });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    // Running it again is a no-op.
    expect(migrate(db, MIGRATIONS)).toEqual([]);
    db.close();
  });

  it("accepts the four states and refuses any other", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    for (const state of ["thinking", "answered", "question", "offline"]) {
      db.prepare(
        "INSERT INTO cards (input_text, chore_type, kind, gemma_state, created_at) VALUES ('x', 'plants', 'weather', ?, 1)",
      ).run(state);
    }
    expect(() =>
      db
        .prepare(
          "INSERT INTO cards (input_text, chore_type, kind, gemma_state, created_at) VALUES ('x', 'plants', 'weather', 'asleep', 1)",
        )
        .run(),
    ).toThrow();
    db.close();
  });
});
