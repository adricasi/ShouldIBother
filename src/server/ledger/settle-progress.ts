import type { JudgeFollowup } from "../gemma/judge.js";
import type { Db } from "../db.js";

import type { ProgressRow } from "./rows.js";

export function getProgress(db: Db, betId: number): ProgressRow | undefined {
  return db
    .prepare<[number], ProgressRow>("SELECT * FROM settle_progress WHERE bet_id = ?")
    .get(betId);
}

/** The row exists as soon as a bet is looked at for settling; `INSERT OR IGNORE` keeps it as is. */
export function ensureProgress(db: Db, betId: number): void {
  db.prepare("INSERT OR IGNORE INTO settle_progress (bet_id) VALUES (?)").run(betId);
}

export function parseFollowups(text: string): JudgeFollowup[] {
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (item): item is JudgeFollowup =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as JudgeFollowup).question === "string" &&
        typeof (item as JudgeFollowup).yes === "boolean",
    );
  } catch {
    return [];
  }
}
