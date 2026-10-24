/**
 * A short, human summary of a device from its user agent ("iPhone · Safari"), kept with the
 * session so `sib devices` can tell linked phones apart. The raw user agent is never stored.
 */

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/iPhone/i, "iPhone"],
  [/iPad/i, "iPad"],
  [/Android/i, "Android"],
  [/CrOS/i, "ChromeOS"],
  [/Windows/i, "Windows"],
  [/Macintosh|Mac OS X/i, "Mac"],
  [/Linux|X11/i, "Linux"],
];

// Order matters: Edge, Opera and the iOS wrappers also say "Chrome" or "Safari".
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

export function summarizeDevice(userAgent: string | undefined): string {
  const agent = (userAgent ?? "").slice(0, 400);
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  if (system === undefined && browser === undefined) {
    return "Unknown device";
  }
  return [system, browser].filter((part) => part !== undefined).join(" · ");
}
