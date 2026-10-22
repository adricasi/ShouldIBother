/** All times in the app are Europe/Madrid (design.md, Overview); storage is epoch milliseconds. */
export const MADRID_TIME_ZONE = "Europe/Madrid";

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
  };
}

/** The wall-clock time in Madrid as if it were UTC, to compare against a wanted wall time. */
function asIfUtc(parts: MadridParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
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
  const today = madridParts(epochMs);
  const wanted = Date.UTC(today.year, today.month - 1, today.day + dayOffset, hour, minute);
  // Madrid is UTC+1 or UTC+2: try both offsets and keep the one that reads back as `wanted`.
  for (const offsetHours of [1, 2]) {
    const candidate = wanted - offsetHours * 3_600_000;
    if (asIfUtc(madridParts(candidate)) === wanted) {
      return candidate;
    }
  }
  // The wanted wall time does not exist (spring-forward gap): use the first valid instant after.
  return wanted - 2 * 3_600_000;
}
