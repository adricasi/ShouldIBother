import { OUTCOME_CHORES, type OutcomeChore } from "./outcomes.js";
import { madridParts, madridWallTime, nextMadridWallTime } from "./time.js";

/**
 * Chore types: the listener's `chore_type` values that have a rule baseline and an outcome label
 * (design.md, Gemma jobs). `laundry_line` is "Line-dry today (skip the dryer)". The other
 * listener values (`laundry_plan`, `other_weather`, `not_weather`) never become a bet here.
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
}

/** A half-open interval `[fromMs, toMs)` of epoch milliseconds. */
export interface InstantWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/** Earliest and latest settle time Gemma may propose; code clamps (design.md, Settle-time bounds). */
export interface SettleBounds {
  readonly earliestMs: number;
  readonly latestMs: number;
}

/** Whether a chore can be offered now; when not, the next time it can (AC-016.4). */
export type Offer =
  { readonly offered: true } | { readonly offered: false; readonly nextAtMs: number };

export interface ChoreSpec {
  readonly title: string;
  /** Plain description of the chore for the judge prompt. */
  readonly judgeName: string;
  readonly tapAnswers: readonly TapAnswer[];
  /**
   * The window the rule baseline and the safety backstop look at, for a card created at `nowMs`
   * (design.md, Rule baseline). Laundry tonight starts at sunset, which only the forecast knows.
   */
  readonly ruleWindow: (nowMs: number, sunsetMs?: number) => InstantWindow;
  /** The settle time of the rule quote: the end of the rule window, inside the chore's bounds. */
  readonly ruleSettleAt: (nowMs: number) => number;
  readonly settleBounds: (nowMs: number) => SettleBounds;
  /** Time-of-day gate of the offer; absent when the chore can be offered at any time. */
  readonly offer?: (nowMs: number) => Offer;
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

/** The 22:00 to 07:00 night the AC rule looks at: the one that ends next, from now if under way. */
function acWindow(nowMs: number): InstantWindow {
  const toMs = nextMadridWallTime(nowMs, 7);
  return { fromMs: Math.max(nowMs, toMs - 9 * 3_600_000), toMs };
}

/** The 08:00 to 22:00 day the heater rule looks at: today's, or tomorrow's once 22:00 has passed. */
function heaterDay(nowMs: number): { dayOffset: number; window: InstantWindow } {
  const dayOffset = madridWallTime(nowMs, 0, 22) > nowMs ? 0 : 1;
  return {
    dayOffset,
    window: {
      fromMs: Math.max(nowMs, madridWallTime(nowMs, dayOffset, 8)),
      toMs: madridWallTime(nowMs, dayOffset, 22),
    },
  };
}

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
      fromMs: Math.max(nowMs, sunsetMs ?? nowMs),
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
};

/** Clamps a settle time Gemma proposed into the chore's bounds (design.md, Settle-time bounds). */
export function clampSettleAt(choreType: ChoreType, nowMs: number, proposedMs: number): number {
  const { earliestMs, latestMs } = CHORES[choreType].settleBounds(nowMs);
  return Math.min(Math.max(proposedMs, earliestMs), latestMs);
}

/** How long a bet can be undone (AC-006.4); T-008 builds the undo itself. */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;
