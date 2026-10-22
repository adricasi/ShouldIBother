import { describe, expect, it } from "vitest";

import {
  BET_STATUSES,
  BET_TRANSITIONS,
  canTransition,
  canUndo,
  isLive,
} from "../src/domain/bet-state.js";
import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const MINUTE = 60_000;

describe("bet state machine (design.md, Data model)", () => {
  it("open → due → awaiting_weather → awaiting_gemma → settled, with the steps in parentheses optional", () => {
    expect(canTransition("open", "due")).toBe(true);
    expect(canTransition("due", "awaiting_weather")).toBe(true);
    expect(canTransition("due", "awaiting_gemma")).toBe(true);
    expect(canTransition("due", "settled")).toBe(true);
    expect(canTransition("awaiting_weather", "awaiting_gemma")).toBe(true);
    expect(canTransition("awaiting_gemma", "settled")).toBe(true);
  });

  it("open → undone only; open|due → cashed_out is reserved for the flagged cash-out", () => {
    expect(canTransition("open", "undone")).toBe(true);
    expect(canTransition("due", "undone")).toBe(false);
    expect(canTransition("open", "cashed_out")).toBe(true);
    expect(canTransition("due", "cashed_out")).toBe(true);
    expect(canTransition("awaiting_gemma", "cashed_out")).toBe(false);
  });

  it("never skips open → settled and never goes back", () => {
    expect(canTransition("open", "settled")).toBe(false);
    expect(canTransition("due", "open")).toBe(false);
    expect(canTransition("settled", "due")).toBe(false);
  });

  it("settled, undone and cashed_out are final", () => {
    for (const status of ["settled", "undone", "cashed_out"] as const) {
      expect(BET_TRANSITIONS[status]).toEqual([]);
      expect(isLive(status)).toBe(false);
    }
    expect(isLive("open")).toBe(true);
  });

  it("AC-006.4, AC-006.5: undo is allowed up to and including undo_until, on an open bet only", () => {
    const bet = { status: "open", undoUntil: 5 * MINUTE } as const;
    expect(canUndo(bet, 0)).toBe(true);
    expect(canUndo(bet, 5 * MINUTE)).toBe(true);
    expect(canUndo(bet, 5 * MINUTE + 1)).toBe(false);
    expect(canUndo({ ...bet, status: "due" }, 0)).toBe(false);
    expect(canUndo({ ...bet, status: "undone" }, 0)).toBe(false);
  });

  it("the trigger of migration 0003 allows exactly the arrows of the TypeScript table", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    db.prepare(
      "INSERT INTO cards (input_text, chore_type, kind, created_at) VALUES ('x', 'plants', 'weather', 1)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO bets (card_id, kind, band, odds, odds_source, reason, rule_band, placed_at,
         undo_until, settle_at, status) VALUES (1, 'do_nothing', 2, 50, 'rule', 'r', 2, 1, 2, 3, ?)`,
    );
    for (const from of BET_STATUSES) {
      for (const to of BET_STATUSES) {
        // Seeding a row in `from` goes through insert (no trigger on INSERT).
        const id = Number(insert.run(from).lastInsertRowid);
        const update = (): unknown =>
          db.prepare("UPDATE bets SET status = ? WHERE id = ?").run(to, id);
        if (from === to || canTransition(from, to)) {
          expect(update, `${from} → ${to}`).not.toThrow();
        } else {
          expect(update, `${from} → ${to}`).toThrow(/state machine/);
        }
      }
    }
  });
});
