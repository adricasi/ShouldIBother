import type { ChoreType } from "../domain/chores.js";
import type { DoNothingVerdict, DoItVerdict } from "../domain/points.js";
import type { FakeWeatherProfile } from "../server/weather/fake.js";
import { FAKE_WEATHER_PROFILES } from "../server/weather/fake.js";

import type { Scene } from "./images.js";

/**
 * The sample history of `sib demo` (AC-029.4): about two weeks of made-up cards and bets, ending
 * at `DEMO_NOW`. Every row goes through the real services (card, quote, bet, settlement, cash-out,
 * appeal) with the scripted bookmaker and judge; only the answers are written here. All numbers
 * the screens show (odds, points, savings, calibration) are computed by the app from these rows.
 */

/** Gemma's band: very unlikely, unlikely, toss-up, likely, very likely. */
export type BandCode = "VU" | "U" | "T" | "L" | "VL";

/** A weather profile by name, or a constant temperature in °C (a calm day or night). */
export type WeatherSpec = keyof typeof PROFILES | number;

export const PROFILES = {
  ...FAKE_WEATHER_PROFILES,
  /** 6 mm of rain over seven hours. */
  downpour: {
    temperatureC: 17,
    dryProbabilityPct: 30,
    rain: { startsAfterHours: 3, hours: 7, mmPerHour: 1 },
  },
  /** 0.6 mm in two light showers. */
  showers: {
    temperatureC: 19,
    dryProbabilityPct: 30,
    rain: { startsAfterHours: 5, hours: 2, mmPerHour: 0.3 },
  },
  /** A fresh, dry day with some sun. */
  fresh: {
    temperatureC: 20,
    dryProbabilityPct: 5,
    windKmh: 15,
    relativeHumidityPct: 45,
    sunshineSeconds: 2400,
  },
  /** Humid, still and grey. */
  muggy: {
    temperatureC: 21,
    dryProbabilityPct: 10,
    windKmh: 8,
    relativeHumidityPct: 70,
    sunshineSeconds: 900,
  },
} as const satisfies Record<string, FakeWeatherProfile>;

export function profileOf(spec: WeatherSpec): FakeWeatherProfile {
  return typeof spec === "number"
    ? { temperatureC: spec, windKmh: 5, dryProbabilityPct: 5 }
    : PROFILES[spec];
}

export type End =
  /** One tap at settle time; the answer follows from the verdict. */
  | { readonly how: "tap"; readonly verdict: DoNothingVerdict; readonly appeal?: Appeal }
  /** An after photo. */
  | {
      readonly how: "photo";
      readonly verdict: DoNothingVerdict;
      readonly scene?: Scene;
      readonly appeal?: Appeal;
    }
  /** No answer for 24 h: the weather record settles it at half points. */
  | { readonly how: "auto"; readonly verdict: DoNothingVerdict }
  /** A do-it decision, scored on the recorded weather. */
  | { readonly how: "do_it"; readonly verdict: DoItVerdict }
  /** Cashed out this many minutes after the bet. */
  | { readonly how: "cash_out"; readonly afterMin: number }
  /** Still waiting for its settle time. */
  | { readonly how: "open" }
  /** Settle time passed, no answer yet. */
  | { readonly how: "due" }
  /** Only a card: no bet yet. */
  | { readonly how: "card" };

/** The appeal photo and the second, final verdict. */
export interface Appeal {
  readonly scene: Scene;
  readonly verdict: DoNothingVerdict;
}

export interface Row {
  /** Days before the demo's today. */
  readonly day: number;
  /** Madrid wall time the card is made. */
  readonly at: string;
  readonly chore: ChoreType;
  readonly weather: WeatherSpec;
  /** Gemma's band, or "rule" when Gemma was offline and the rule's odds stand. */
  readonly odds: BandCode | "rule";
  readonly end: End;
  /** Extra hours between the earliest settle time and the one Gemma proposes. */
  readonly late?: number;
  /** Minutes after the settle time the person answers (default 20 to 100, by row). */
  readonly answerAfterMin?: number;
  /** Required when Gemma is two bands or more from the rule. */
  readonly disagreement?: string;
}

const r = (
  day: number,
  at: string,
  chore: ChoreType,
  weather: WeatherSpec,
  odds: BandCode | "rule",
  end: End,
  extra: Partial<Pick<Row, "late" | "answerAfterMin" | "disagreement">> = {},
): Row => ({ day, at, chore, weather, odds, end, ...extra });

const win = (how: "tap" | "photo" = "tap"): End => ({ how, verdict: "win" });
const lose = (verdict: DoNothingVerdict, how: "tap" | "photo" = "tap"): End => ({ how, verdict });

/**
 * Oldest first. Weather names and temperatures are picked so the rule's band lands next to Gemma's
 * (see rules.json); a few rows differ by a band on purpose, and two by more, with a reason.
 */
export const HISTORY: readonly Row[] = [
  r(14, "20:10", "plants", "rainy", "L", win("photo")),
  r(13, "09:30", "laundry_line", "fresh", "L", win("photo")),
  r(13, "18:40", "ac", 18, "VL", win()),
  r(12, "09:50", "heater", 16, "T", win()),
  r(12, "20:20", "plants", "mild", "rule", win("photo")),
  r(11, "10:10", "laundry_line", "muggy", "U", {
    how: "tap",
    verdict: "normal_loss",
    appeal: { scene: "line_dry", verdict: "win" },
  }),
  r(11, "20:15", "laundry_tonight", "mild", "T", lose("small_loss")),
  r(10, "08:50", "laundry_line", "breezy", "VL", win("photo")),
  r(10, "20:30", "plants", "showers", "T", win("photo")),
  r(9, "09:40", "laundry_line", "mild", "T", win("photo")),
  r(9, "19:20", "plants", "downpour", "VL", { how: "auto", verdict: "win" }),
  r(9, "20:00", "ac", 24, "T", win()),
  r(9, "20:40", "laundry_tonight", "breezy", "L", win("photo")),
  r(8, "09:15", "laundry_line", "rainy", "VU", lose("normal_loss")),
  r(8, "10:20", "heater", 13, "rule", lose("small_loss")),
  r(8, "20:10", "plants", "mild", "U", win("photo")),
  r(7, "20:05", "plants", "hot", "VU", {
    how: "tap",
    verdict: "normal_loss",
    appeal: { scene: "plants_dry", verdict: "normal_loss" },
  }),
  r(7, "21:10", "ac", 26, "U", lose("small_loss")),
  r(6, "08:50", "laundry_line", "breezy", "VL", { how: "do_it", verdict: "weather_would_not" }),
  r(6, "10:40", "laundry_line", "fresh", "L", win("photo")),
  r(6, "19:50", "plants", "mild", "U", win("photo")),
  r(5, "09:40", "heater", 18.5, "L", lose("small_loss")),
  r(5, "20:00", "plants", "showers", "T", win("photo")),
  r(5, "20:25", "laundry_tonight", "breezy", "rule", win("photo")),
  r(4, "09:05", "laundry_line", "mild", "T", { how: "cash_out", afterMin: 230 }),
  r(4, "20:15", "plants", "showers", "T", lose("normal_loss")),
  r(3, "11:05", "heater", 21, "VL", { how: "auto", verdict: "win" }),
  r(3, "13:20", "laundry_line", "muggy", "U", lose("normal_loss")),
  r(3, "19:30", "ac", 22, "L", win()),
  r(3, "19:55", "plants", "rainy", "L", win("photo")),
  r(2, "09:25", "laundry_line", "breezy", "VL", lose("small_loss")),
  r(2, "20:00", "plants", "downpour", "VL", win("photo")),
  r(2, "20:30", "plants", "rainy", "L", { how: "do_it", verdict: "weather_would_have" }),
  r(2, "20:45", "laundry_tonight", "muggy", "U", lose("normal_loss")),
  r(1, "10:00", "laundry_line", "fresh", "L", lose("small_loss")),
  r(1, "20:10", "laundry_tonight", "breezy", "L", lose("small_loss")),
  r(1, "20:30", "ac", 22, "L", win()),
];

/** Today, 23 October 2026, ten o'clock: waiting, due and fresh cards. */
export const TODAY: readonly Row[] = [
  r(1, "19:30", "plants", "showers", "T", { how: "due" }),
  r(0, "08:40", "laundry_line", "breezy", "VL", { how: "open" }),
  r(0, "09:10", "heater", 18.5, "L", { how: "open" }),
  r(0, "09:30", "plants", "rainy", "L", { how: "open" }),
  r(0, "09:40", "ac", 22, "L", { how: "open" }),
  r(0, "09:50", "plants", "mild", "U", { how: "card" }),
  r(0, "09:55", "laundry_line", "fresh", "L", { how: "card" }),
  r(0, "09:58", "ac", "heatwave", "T", { how: "card" }),
  r(0, "09:59", "laundry_tonight", "mild", "T", { how: "card" }),
];
