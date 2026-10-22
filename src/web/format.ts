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

/** "2 h 10 min", "6 min", "1 min 30 s", "30 s": a length of time for the savings lines (AC-011.3). */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(Math.abs(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours} h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} min`);
  }
  // Seconds only matter while the whole is under 10 minutes.
  if (rest > 0 && seconds < 600) {
    parts.push(`${rest} s`);
  }
  return parts.length === 0 ? "0 min" : parts.join(" ");
}

/** Net time back keeps its sign: "+2 h 10 min", "−1 min" (a real minus sign). */
export function formatNetDuration(totalSeconds: number): string {
  const text = formatDuration(totalSeconds);
  if (totalSeconds < 0) {
    return `−${text}`;
  }
  return totalSeconds > 0 ? `+${text}` : text;
}

/** "4 L", "0.5 L": litres of water with at most one decimal. */
export function formatLitres(litres: number): string {
  return `${Number(litres.toFixed(1))} L`;
}

/** "2.2 kWh": electricity with at most two decimals. */
export function formatKwh(kwh: number): string {
  return `${Number(kwh.toFixed(2))} kWh`;
}

const hourOnly = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "08:00": a clock time in Madrid time. */
export function formatClock(iso: string): string {
  return hourOnly.format(new Date(iso));
}

const madridDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** True when the instant `iso` falls on the same Madrid calendar day as `nowMs`. */
export function isMadridToday(iso: string, nowMs: number): boolean {
  return madridDay.format(new Date(iso)) === madridDay.format(new Date(nowMs));
}
