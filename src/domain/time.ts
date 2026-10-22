/**
 * Europe/Madrid time helpers: the single implementation behind the app's windows, settle bounds,
 * the outcome labels and the backtest. All times in the app are Europe/Madrid (design.md,
 * Overview); storage is epoch milliseconds. No dependencies: `Intl` has the tz database.
 */
export const MADRID_TIME_ZONE = "Europe/Madrid";
export const HOUR_MS = 3_600_000;

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: MADRID_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

export interface MadridParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export function madridParts(epochMs: number): MadridParts {
  const parts = new Map(
    formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, Number(part.value)]),
  );
  const part = (type: Intl.DateTimeFormatPartTypes): number => parts.get(type) ?? Number.NaN;
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** Madrid's offset from UTC at an instant, in milliseconds. */
function madridOffsetMs(epochMs: number): number {
  const p = madridParts(epochMs);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

function parseDate(date: string): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(date);
  if (match === null) {
    throw new Error(`invalid date "${date}", expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`invalid calendar date "${date}"`);
  }
  return { year, month, day };
}

/** Throws unless `date` is a real calendar date written YYYY-MM-DD. */
export function assertIsoDate(date: string): void {
  parseDate(date);
}

/** Instant of a Madrid wall-clock time ("HH:MM") on a Madrid calendar date. */
export function madridWallTimeToEpochMs(date: string, time: string): number {
  const { year, month, day } = parseDate(date);
  const timeMatch = TIME_PATTERN.exec(time);
  if (timeMatch === null) {
    throw new Error(`invalid time "${time}", expected HH:MM`);
  }
  const wallAsUtc = Date.UTC(year, month - 1, day, Number(timeMatch[1]), Number(timeMatch[2]));
  const firstGuess = wallAsUtc - madridOffsetMs(wallAsUtc);
  return wallAsUtc - madridOffsetMs(firstGuess);
}

/** Madrid calendar date (YYYY-MM-DD) of an instant. */
export function madridDateOf(epochMs: number): string {
  const p = madridParts(epochMs);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Calendar arithmetic on YYYY-MM-DD strings (no time zone involved). */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Inclusive list of dates from `start` to `end` (empty if end < start). */
export function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

/**
 * The instant at which Madrid's clock shows `hour:minute` on the calendar day `dayOffset` days
 * after the Madrid day of `epochMs`. Correct across the October and March clock changes.
 */
export function madridWallTime(
  epochMs: number,
  dayOffset: number,
  hour: number,
  minute = 0,
): number {
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return madridWallTimeToEpochMs(addDays(madridDateOf(epochMs), dayOffset), time);
}

/** The first instant after `epochMs` at which Madrid's clock shows `hour:minute`. */
export function nextMadridWallTime(epochMs: number, hour: number, minute = 0): number {
  const today = madridWallTime(epochMs, 0, hour, minute);
  return today > epochMs ? today : madridWallTime(epochMs, 1, hour, minute);
}
