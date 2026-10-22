const TIME_ZONE = "Europe/Madrid";

const dayAndTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const longDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** "Fri 23 Oct, 08:00": the settle time in Madrid time, as the household sees it. */
export function formatSettleTime(iso: string): string {
  return dayAndTime.format(new Date(iso));
}

/** "Thursday 22 October" for the header of Today. */
export function formatLongDate(iso: string): string {
  return longDate.format(new Date(iso));
}

/** "+15", "-50" (a real minus sign) for points. */
export function formatPoints(points: number): string {
  if (points > 0) {
    return `+${points}`;
  }
  return points < 0 ? `−${Math.abs(points)}` : "0";
}

/** Odds always come with plain words (AC-003.5): "Likely · 70%". */
export function formatOdds(bandName: string, odds: number): string {
  return `${bandName.charAt(0).toUpperCase()}${bandName.slice(1)} · ${odds}%`;
}

const MINUTE_MS = 60_000;

/** "4 h 12 min", "35 min", "less than a minute": the countdown to a settle time (AC-007.1). */
export function formatTimeLeft(milliseconds: number): string {
  if (milliseconds <= 0) {
    return "now";
  }
  if (milliseconds < MINUTE_MS) {
    return "less than a minute";
  }
  const minutes = Math.ceil(milliseconds / MINUTE_MS);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} d ${hours % 24} h`;
  }
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
