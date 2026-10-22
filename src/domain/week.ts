import { addDays, madridDateOf, madridWallTimeToEpochMs } from "./time.js";

export interface Week {
  /** Monday 00:00 Madrid time, epoch milliseconds, included. */
  readonly fromMs: number;
  /** The next Monday 00:00 Madrid time, excluded. */
  readonly toMs: number;
  /** Monday's date, YYYY-MM-DD. */
  readonly fromDate: string;
  /** Sunday's date, YYYY-MM-DD. */
  readonly toDate: string;
}

/** The Monday-to-Sunday week of an instant in Europe/Madrid (AC-011.6), clock changes included. */
export function madridWeekOf(epochMs: number): Week {
  const today = madridDateOf(epochMs);
  // 0 = Sunday ... 6 = Saturday, for the calendar date itself (no time zone involved).
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const fromDate = addDays(today, -((weekday + 6) % 7));
  const nextMonday = addDays(fromDate, 7);
  return {
    fromMs: madridWallTimeToEpochMs(fromDate, "00:00"),
    toMs: madridWallTimeToEpochMs(nextMonday, "00:00"),
    fromDate,
    toDate: addDays(fromDate, 6),
  };
}
