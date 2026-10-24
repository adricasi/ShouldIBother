import { OUTCOME_CHORES, type OutcomeChore } from "./outcomes.js";
import { HOUR_MS, madridDateOf, madridParts, madridWallTime, nextMadridWallTime } from "./time.js";

/**
 * Chore types: the listener's `chore_type` values that have a rule baseline and an outcome label
 * (design.md, Gemma jobs). `laundry_line` is "Line-dry today (skip the dryer)"; the last four are
 * the city rain bets (REQ-030, flag `rainChores`). The other listener values (`laundry_plan`, the
 * advice chores, `other_weather`, `not_weather`) never become a bet here.
 */
export const CHORE_TYPES = OUTCOME_CHORES;
export type ChoreType = OutcomeChore;

export function isChoreType(value: unknown): value is ChoreType {
  return CHORE_TYPES.some((type) => type === value);
}

/** The one-tap answers a household member gives at settle time (REQ-008, AC-008.3). */
export interface TapAnswer {
  readonly id: string;
  readonly label: string;
  /** True when this answer can never be a win ("Still dirty", "Dirtier than before"; AC-030.2). */
  readonly isLoss?: true;
}

/** A half-open interval `[fromMs, toMs)` of epoch milliseconds. */
export interface InstantWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Earliest and latest settle time Gemma may propose; code clamps (design.md, Settle-time bounds).
 * A chore that can settle only at some hours of each day (the rain bets, 08:00 to 20:00) also
 * lists its `slots`: closed intervals inside the bounds, in time order; a proposal is moved to the
 * nearest point of a slot.
 */
export interface SettleBounds {
  readonly earliestMs: number;
  readonly latestMs: number;
  readonly slots?: readonly InstantWindow[];
}

/** Whether a chore can be offered now; when not, the next time it can (AC-016.4). */
export type Offer =
  { readonly offered: true } | { readonly offered: false; readonly nextAtMs: number };

export interface ChoreSpec {
  readonly title: string;
  /** Plain description of the chore for the judge prompt. */
  readonly judgeName: string;
  readonly tapAnswers: readonly TapAnswer[];
  /** True when nothing can be damaged, so the judge may not answer `harmful_loss` (REQ-030). */
  readonly noHarmfulLoss?: true;
  /**
   * The window the rule baseline and the safety backstop look at, for a card created at `nowMs`
   * (design.md, Rule baseline). Only plants and line-dry start "now"; the AC's night, the
   * heater's day and laundry tonight are whole fixed windows, so the live band equals the band
   * the backtest and the fine-tune labels use. Laundry tonight starts at sunset, which only the
   * forecast knows.
   */
  readonly ruleWindow: (nowMs: number, sunsetMs?: number) => InstantWindow;
  /** The settle time of the rule quote: the end of the rule window, inside the chore's bounds. */
  readonly ruleSettleAt: (nowMs: number) => number;
  readonly settleBounds: (nowMs: number) => SettleBounds;
  /** Time-of-day gate of the offer; absent when the chore can be offered at any time. */
  readonly offer?: (nowMs: number) => Offer;
  /** The hours the offer is open, for the card text when it is closed (AC-016.4). */
  readonly offerWindow?: { readonly fromHour: number; readonly toHour: number };
}

/** Line-dry today is offered 07:00 to 15:00 Madrid time, lower bound included (AC-016.4). */
export const LINE_DRY_OFFER = { fromHour: 7, toHour: 15 } as const;

function lineDryOffer(nowMs: number): Offer {
  const hour = madridParts(nowMs).hour;
  if (hour >= LINE_DRY_OFFER.fromHour && hour < LINE_DRY_OFFER.toHour) {
    return { offered: true };
  }
  return { offered: false, nextAtMs: nextMadridWallTime(nowMs, LINE_DRY_OFFER.fromHour) };
}

/**
 * The whole 22:00 to 07:00 night the AC rule looks at: the one that ends next. It starts at 22:00
 * the evening before that morning, found by the Madrid calendar so a night with a clock change
 * (9 or 11 hours long) is right.
 */
function acWindow(nowMs: number): InstantWindow {
  const toMs = nextMadridWallTime(nowMs, 7);
  return { fromMs: madridWallTime(toMs, -1, 22), toMs };
}

/** The whole 08:00 to 22:00 day the heater rule looks at: today's, or tomorrow's once 22:00 has passed. */
function heaterDay(nowMs: number): { dayOffset: number; window: InstantWindow } {
  const dayOffset = madridWallTime(nowMs, 0, 22) > nowMs ? 0 : 1;
  return {
    dayOffset,
    window: {
      fromMs: madridWallTime(nowMs, dayOffset, 8),
      toMs: madridWallTime(nowMs, dayOffset, 22),
    },
  };
}

/**
 * The city rain bets settle 12 to 48 hours after the card is made, between 08:00 and 20:00 Madrid
 * time (design.md, City rain bets). The slots are each day's 08:00 to 20:00 cut to that range; the
 * range is 36 hours long, so there is always one.
 */
function rainSettleBounds(nowMs: number): SettleBounds {
  const earliestMs = nowMs + 12 * HOUR_MS;
  const latestMs = nowMs + 48 * HOUR_MS;
  const slots: InstantWindow[] = [];
  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    const fromMs = Math.max(earliestMs, madridWallTime(nowMs, dayOffset, 8));
    const toMs = Math.min(latestMs, madridWallTime(nowMs, dayOffset, 20));
    if (fromMs <= toMs) {
      slots.push({ fromMs, toMs });
    }
  }
  return {
    earliestMs: slots[0]?.fromMs ?? earliestMs,
    latestMs: slots[slots.length - 1]?.toMs ?? latestMs,
    slots,
  };
}

/** The rinse bets look at the rain over the 24 hours after the card is made (design.md). */
const RAIN_RINSE_WINDOW_MS = 24 * HOUR_MS;
const rinseRuleWindow = (nowMs: number): InstantWindow => ({
  fromMs: nowMs,
  toMs: nowMs + RAIN_RINSE_WINDOW_MS,
});

const RINSE_TAP_ANSWERS = (prefix: string): readonly TapAnswer[] => [
  { id: `${prefix}_clean`, label: "Clean enough" },
  { id: `${prefix}_dirty`, label: "Still dirty", isLoss: true },
  { id: `${prefix}_dirtier`, label: "Dirtier than before", isLoss: true },
];

export const CHORES: Readonly<Record<ChoreType, ChoreSpec>> = {
  plants: {
    title: "Water plants",
    judgeName: "water the balcony plants",
    tapAnswers: [
      { id: "moist", label: "Still moist, all fine" },
      { id: "dry", label: "Soil is dry" },
      { id: "wilting", label: "Wilting or drooping" },
    ],
    // Plants settle the next day between 08:00 and 12:00 Madrid time; the rule uses the earliest.
    ruleWindow: (nowMs) => ({ fromMs: nowMs, toMs: madridWallTime(nowMs, 1, 8) }),
    ruleSettleAt: (nowMs) => madridWallTime(nowMs, 1, 8),
    settleBounds: (nowMs) => ({
      earliestMs: madridWallTime(nowMs, 1, 8),
      latestMs: madridWallTime(nowMs, 1, 12),
    }),
  },
  laundry_line: {
    title: "Line-dry today (skip the dryer)",
    judgeName: "line-dry the laundry today instead of using the dryer",
    tapAnswers: [
      { id: "line_dry", label: "Yes, dry" },
      { id: "line_damp", label: "Still damp" },
      { id: "line_wet", label: "Wet" },
    ],
    // Same day, settle between 18:00 and 21:00; the rule window ends at the earliest.
    ruleWindow: (nowMs) => ({ fromMs: nowMs, toMs: madridWallTime(nowMs, 0, 18) }),
    ruleSettleAt: (nowMs) => madridWallTime(nowMs, 0, 18),
    settleBounds: (nowMs) => ({
      earliestMs: madridWallTime(nowMs, 0, 18),
      latestMs: madridWallTime(nowMs, 0, 21),
    }),
    offer: lineDryOffer,
    offerWindow: LINE_DRY_OFFER,
  },
  laundry_tonight: {
    title: "Leave it out tonight",
    judgeName: "leave the laundry out overnight",
    tapAnswers: [
      { id: "tonight_dry", label: "Dry this morning" },
      { id: "tonight_damp", label: "Damp from dew" },
      { id: "tonight_wet", label: "Wet from rain" },
    ],
    ruleWindow: (nowMs, sunsetMs) => ({
      fromMs: sunsetMs ?? nowMs,
      toMs: madridWallTime(nowMs, 1, 8),
    }),
    ruleSettleAt: (nowMs) => madridWallTime(nowMs, 1, 8),
    settleBounds: (nowMs) => ({
      earliestMs: madridWallTime(nowMs, 1, 8),
      latestMs: madridWallTime(nowMs, 1, 10),
    }),
  },
  ac: {
    title: "Skip the AC",
    judgeName: "sleep without the air conditioning",
    tapAnswers: [
      { id: "ac_fine", label: "Slept fine without it" },
      { id: "ac_warm", label: "Too warm, I used it" },
    ],
    ruleWindow: acWindow,
    ruleSettleAt: (nowMs) => acWindow(nowMs).toMs,
    settleBounds: (nowMs) => {
      const earliestMs = acWindow(nowMs).toMs;
      return { earliestMs, latestMs: earliestMs + 2 * 3_600_000 };
    },
  },
  heater: {
    title: "Skip the heater",
    judgeName: "get through the day without the heater",
    tapAnswers: [
      { id: "heater_fine", label: "Comfortable without it" },
      { id: "heater_cold", label: "Too cold, I used it" },
    ],
    ruleWindow: (nowMs) => heaterDay(nowMs).window,
    ruleSettleAt: (nowMs) => heaterDay(nowMs).window.toMs,
    settleBounds: (nowMs) => {
      const { dayOffset } = heaterDay(nowMs);
      return {
        earliestMs: madridWallTime(nowMs, dayOffset, 21),
        latestMs: madridWallTime(nowMs, dayOffset, 23),
      };
    },
  },
  car_rinse: {
    title: "Rinse the car",
    judgeName: "let the rain rinse the car instead of washing it",
    tapAnswers: RINSE_TAP_ANSWERS("car"),
    noHarmfulLoss: true,
    ruleWindow: rinseRuleWindow,
    ruleSettleAt: (nowMs) => rainSettleBounds(nowMs).earliestMs,
    settleBounds: rainSettleBounds,
  },
  bike_rinse: {
    title: "Rinse the bike",
    judgeName: "let the rain rinse the bike instead of washing it",
    tapAnswers: RINSE_TAP_ANSWERS("bike"),
    noHarmfulLoss: true,
    ruleWindow: rinseRuleWindow,
    ruleSettleAt: (nowMs) => rainSettleBounds(nowMs).earliestMs,
    settleBounds: rainSettleBounds,
  },
  terrace_rinse: {
    title: "Rinse the terrace",
    judgeName: "let the rain rinse the terrace or the outdoor furniture instead of washing it",
    noHarmfulLoss: true,
    tapAnswers: [
      { id: "terrace_rinsed", label: "Rinsed clean" },
      { id: "terrace_dirty", label: "Still dirty", isLoss: true },
    ],
    ruleWindow: rinseRuleWindow,
    ruleSettleAt: (nowMs) => rainSettleBounds(nowMs).earliestMs,
    settleBounds: rainSettleBounds,
  },
  rain_fill: {
    title: "Fill the rain barrel",
    judgeName: "let the rain fill the rain barrel, pond or bird bath instead of filling it",
    noHarmfulLoss: true,
    tapAnswers: [
      { id: "fill_full", label: "Filled up" },
      { id: "fill_low", label: "Still low", isLoss: true },
    ],
    // The barrel is checked the next morning, 08:00 to 12:00 (design.md, City rain bets).
    ruleWindow: (nowMs) => ({ fromMs: nowMs, toMs: madridWallTime(nowMs, 1, 8) }),
    ruleSettleAt: (nowMs) => madridWallTime(nowMs, 1, 8),
    settleBounds: (nowMs) => ({
      earliestMs: madridWallTime(nowMs, 1, 8),
      latestMs: madridWallTime(nowMs, 1, 12),
    }),
  },
};

/** Clamps a settle time Gemma proposed into the chore's bounds (design.md, Settle-time bounds). */
export function clampSettleAt(choreType: ChoreType, nowMs: number, proposedMs: number): number {
  const { earliestMs, latestMs, slots } = CHORES[choreType].settleBounds(nowMs);
  const clamped = Math.min(Math.max(proposedMs, earliestMs), latestMs);
  if (slots === undefined || slots.length === 0) {
    return clamped;
  }
  // Inside a slot it stays; at night it moves to the next slot's start (the nearest later instant).
  if (slots.some((slot) => clamped >= slot.fromMs && clamped <= slot.toMs)) {
    return clamped;
  }
  return slots.find((slot) => slot.fromMs > clamped)?.fromMs ?? clamped;
}

/** How long a bet can be undone (AC-006.4); T-008 builds the undo itself. */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

/** The words on cards that have no odds and no bet action. */
export const NOTICES = {
  noForecast: "No forecast, can't set odds",
  notNeeded: "Not needed this season",
  comingLater: "Coming later",
} as const;

/** "today at 07:00" or "tomorrow at 07:00": when an offer opens next, in Madrid time. */
export function describeNextOffer(nowMs: number, nextAtMs: number): string {
  const { hour, minute } = madridParts(nextAtMs);
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const sameDay = madridDateOf(nowMs) === madridDateOf(nextAtMs);
  return `${sameDay ? "today" : "tomorrow"} at ${time}`;
}

/**
 * The card text for a chore that cannot be offered now (AC-016.4), from the chore's own offer
 * hours. It does not repeat the chore's title: the card shows that above it.
 */
export function offerNotice(choreType: ChoreType, nowMs: number, nextAtMs: number): string {
  const { offerWindow } = CHORES[choreType];
  const hours = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;
  const open =
    offerWindow === undefined
      ? ""
      : `Offered from ${hours(offerWindow.fromHour)} to ${hours(offerWindow.toHour)}. `;
  return `${open}Next chance: ${describeNextOffer(nowMs, nextAtMs)}.`;
}

/**
 * "Leave it out tonight" is offered from 1 h before to 2 h after sunset, lower bound included
 * (AC-016.2): the laundry goes out as the light goes. Intervals are half-open like the rest.
 */
export const LAUNDRY_TONIGHT_OFFER = {
  beforeSunsetMs: HOUR_MS,
  afterSunsetMs: 2 * HOUR_MS,
} as const;

/** Whether "Leave it out tonight" can be offered now; when not, when it can next (if known). */
export type SunsetOffer =
  { readonly offered: true } | { readonly offered: false; readonly nextAtMs: number | undefined };

/**
 * The offer gate of laundry tonight. `sunsetMs` is today's sunset; `nextSunsetMs` tomorrow's, used
 * for "next chance" once today's window has closed (unknown: the card says "tomorrow evening").
 */
export function laundryTonightOffer(
  nowMs: number,
  sunsetMs: number,
  nextSunsetMs?: number,
): SunsetOffer {
  const opensAtMs = sunsetMs - LAUNDRY_TONIGHT_OFFER.beforeSunsetMs;
  if (nowMs < opensAtMs) {
    return { offered: false, nextAtMs: opensAtMs };
  }
  if (nowMs >= sunsetMs + LAUNDRY_TONIGHT_OFFER.afterSunsetMs) {
    return {
      offered: false,
      nextAtMs:
        nextSunsetMs === undefined
          ? undefined
          : nextSunsetMs - LAUNDRY_TONIGHT_OFFER.beforeSunsetMs,
    };
  }
  return { offered: true };
}

/** The card text when laundry tonight cannot be offered now (AC-016.2). */
export function laundryTonightNotice(nowMs: number, nextAtMs: number | undefined): string {
  const open = "Offered from 1 h before to 2 h after sunset.";
  return nextAtMs === undefined
    ? `${open} Next chance: tomorrow evening.`
    : `${open} Next chance: ${describeNextOffer(nowMs, nextAtMs)}.`;
}

/**
 * The laundry planner's `chore_type` (the listener's value, REQ-021). It is not in `CHORE_TYPES`:
 * it has no rule window of its own, no offer window and no Gemma settle time (a Skip today bet
 * settles at 18:00 on the chosen day), and quick chips and the backtest never see it.
 */
export const LAUNDRY_PLAN = "laundry_plan";

/** What the settle screen, the judge and the receipt need to know about a chore. */
export type BetChoreSpec = Pick<ChoreSpec, "title" | "judgeName" | "tapAnswers" | "noHarmfulLoss">;

/**
 * A Skip today bet: the load is washed and hung out on the day the planner chose, and the bet wins
 * only if it dried outside that day (AC-021.4). Settled with the line-dry outcome label.
 */
export const LAUNDRY_PLAN_SPEC: BetChoreSpec = {
  title: "Skip washing today",
  judgeName: "skip washing today and line-dry the load outside on the day the planner chose",
  tapAnswers: [
    { id: "plan_dry", label: "Dried outside" },
    { id: "plan_damp", label: "Still damp" },
    { id: "plan_wet", label: "Rained on it" },
  ],
};

/** The settle-screen spec of a bettable chore, including the planner's Skip today (REQ-021). */
export function betChoreSpec(choreType: string): BetChoreSpec | undefined {
  if (isChoreType(choreType)) {
    return CHORES[choreType];
  }
  return choreType === LAUNDRY_PLAN ? LAUNDRY_PLAN_SPEC : undefined;
}
