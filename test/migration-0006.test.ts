import { describe, expect, it } from "vitest";

import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const BEFORE = MIGRATIONS.filter((migration) => migration.id < 6);

/** A database as the live week leaves it at migration 0005: a bet, a photo-less card, a decision. */
function seedLiveDatabase(db: Db): void {
  migrate(db, BEFORE);
  db.exec(`
    INSERT INTO cards (input_text, chore_type, kind, gemma_state, created_at)
      VALUES ('Water plants', 'plants', 'weather', 'answered', 1);
    INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('Water plants', 'plants', 'weather', 2);
    INSERT INTO quotes (card_id, source, band, odds, reason, settle_at, created_at)
      VALUES (1, 'rule', 3, 70, 'rain', 30, 1), (2, 'rule', 1, 35, 'dry', 40, 2);
    INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at, undo_until, settle_at, status)
      VALUES (1, 'do_nothing', 3, 70, 'rule', 'rain', 3, 10, 20, 30, 'open');
    INSERT INTO gemma_decisions (job, card_id, model, prompt_version, valid, latency_ms, created_at)
      VALUES ('bookmaker', 1, 'm', 'bookmaker.v1', 1, 5, 12);
  `);
}

describe("migration 0006: where a card's photo stands with the inspector (NFR-003)", () => {
  it("is number 6", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toContain(6);
  });

  it("keeps every existing card, quote, decision and open bet; old cards have no photo state", () => {
    const db = openDatabase(":memory:");
    seedLiveDatabase(db);
    const betsBefore = db.prepare("SELECT * FROM bets").all();
    const cardsBefore = db.prepare("SELECT * FROM cards ORDER BY id").all();
    expect(migrate(db, MIGRATIONS)).toEqual([6]);
    expect(db.prepare("SELECT * FROM cards ORDER BY id").all()).toEqual(
      cardsBefore.map((card) => ({ ...(card as object), photo_state: null, photo_failure: null })),
    );
    expect(db.prepare("SELECT * FROM bets").all()).toEqual(betsBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM quotes").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gemma_decisions").get()).toEqual({ n: 1 });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(migrate(db, MIGRATIONS)).toEqual([]);
    db.close();
  });

  it("accepts the four photo states and refuses any other", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    for (const state of ["inspecting", "seen", "unsure", "failed"]) {
      db.prepare(
        "INSERT INTO cards (input_text, chore_type, kind, photo_state, created_at) VALUES ('x', 'plants', 'weather', ?, 1)",
      ).run(state);
    }
    expect(() =>
      db
        .prepare(
          "INSERT INTO cards (input_text, chore_type, kind, photo_state, created_at) VALUES ('x', 'plants', 'weather', 'blurry', 1)",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("AC-005.5: band_without_photo can be written in the bet INSERT and never rewritten", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    db.exec(`
      INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('x', 'plants', 'weather', 1);
      INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, band_without_photo,
        placed_at, undo_until, settle_at, status)
        VALUES (1, 'do_nothing', 2, 50, 'gemma', 'r', 1, 1, 10, 20, 30, 'open');
    `);
    expect(() => db.prepare("UPDATE bets SET band_without_photo = 3").run()).toThrow(
      /cannot be updated/,
    );
    db.close();
  });
});
