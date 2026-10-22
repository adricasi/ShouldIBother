import {
  ACHIEVEMENTS,
  earnedAchievements,
  type AchievementId,
  type BetResult,
} from "../../domain/ranks.js";

import type { LedgerDeps } from "./deps.js";

type AchievementDeps = Pick<LedgerDeps, "db">;

/** One achievement as the Score screen shows it: unlocked or not, with when. */
export interface AchievementView {
  readonly id: AchievementId;
  readonly name: string;
  readonly condition: string;
  /** ISO time of the event that met the condition; null while locked. */
  readonly unlocked_at: string | null;
}

interface SettledRow {
  readonly at: number;
  readonly bet_id: number;
  readonly odds: number;
  readonly verdict: string;
}

interface CashOutAtRow {
  readonly at: number;
  readonly bet_id: number;
}

/**
 * How every bet on doing nothing ended, oldest first (ties by bet id): the final verdict of each
 * settled bet at the time it was first settled, and each cash-out. An appeal can change a verdict
 * but not the place of the bet in the sequence. Do-it decisions and undone bets are not in it.
 */
export function betResults(deps: AchievementDeps): BetResult[] {
  const settled = deps.db
    .prepare<[], SettledRow>(
      `SELECT o.settled_at AS at, b.id AS bet_id, b.odds AS odds, s.verdict AS verdict
       FROM bets b
       JOIN settlements o ON o.bet_id = b.id AND o.appeal_of IS NULL
       JOIN settlements s ON s.id = (
         SELECT MAX(id) FROM settlements WHERE bet_id = b.id AND final = 1
       )
       WHERE b.kind = 'do_nothing' AND b.status = 'settled'`,
    )
    .all();
  const cashOuts = deps.db
    .prepare<[], CashOutAtRow>("SELECT cashed_out_at AS at, bet_id FROM cash_outs")
    .all();
  const ordered: { at: number; betId: number; result: BetResult }[] = [
    ...settled.map((row) => ({
      at: row.at,
      betId: row.bet_id,
      result:
        row.verdict === "win"
          ? ({ kind: "win", at: row.at, odds: row.odds } as const)
          : ({ kind: "loss", at: row.at } as const),
    })),
    ...cashOuts.map((row) => ({
      at: row.at,
      betId: row.bet_id,
      result: { kind: "cash_out", at: row.at } as const,
    })),
  ];
  ordered.sort((a, b) => a.at - b.at || a.betId - b.betId);
  return ordered.map((entry) => entry.result);
}

/**
 * Unlocks every achievement whose condition the settled data meets and that is not unlocked yet,
 * once each (AC-025.2). Only the missing ones are written, in one transaction, so a call with
 * nothing new does no write; the primary key keeps a row once even if two calls race.
 * `unlocked_at` is the time of the settlement or cash-out that met the condition, so it does not
 * matter when this runs. It runs right after a settlement, an appeal or a cash-out commits
 * (`unlockAfterCommit`, so deleting the bet's data before the Score is read cannot lose an
 * unlock) and again on every Score read (catch-up for bets settled while the flag was off).
 * Unlocks are permanent: nothing here deletes a row, so an appeal that turns a win into a loss
 * does not take one back. Returns every achievement with its state.
 */
export function syncAchievements(deps: AchievementDeps): AchievementView[] {
  const earned = earnedAchievements(betResults(deps));
  const stored = new Map(
    deps.db
      .prepare<[], { id: string; unlocked_at: number }>("SELECT id, unlocked_at FROM achievements")
      .all()
      .map((row) => [row.id, row.unlocked_at]),
  );
  const missing = [...earned].filter(([id]) => !stored.has(id));
  if (missing.length > 0) {
    deps.db.transaction(() => {
      const insert = deps.db.prepare(
        "INSERT OR IGNORE INTO achievements (id, unlocked_at) VALUES (?, ?)",
      );
      for (const [id, at] of missing) {
        insert.run(id, at);
        stored.set(id, at);
      }
    })();
  }
  return ACHIEVEMENTS.map((achievement) => {
    const at = stored.get(achievement.id);
    return {
      ...achievement,
      unlocked_at: at === undefined ? null : new Date(at).toISOString(),
    };
  });
}

/**
 * The hook after a settlement, appeal or cash-out commits: unlocks what that event earned while
 * the `ranks` flag is on (REQ-029: with it off nothing is read or written). The event is already
 * committed, so a failure here must not fail the request; the next Score read unlocks it, and
 * the failure is logged (ids and messages only).
 */
export function unlockAfterCommit(
  deps: Pick<LedgerDeps, "db" | "flags"> & Partial<Pick<LedgerDeps, "log">>,
): void {
  if (!deps.flags.ranks) {
    return;
  }
  try {
    syncAchievements(deps);
  } catch (error) {
    deps.log?.({
      event: "achievements-sync-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
