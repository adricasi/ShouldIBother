import { madridWallTime } from "./time.js";

/** Chore types of this build; T-005 and later add line-dry, laundry, AC and heater. */
export const CHORE_TYPES = ["plants"] as const;
export type ChoreType = (typeof CHORE_TYPES)[number];

export function isChoreType(value: unknown): value is ChoreType {
  return CHORE_TYPES.some((type) => type === value);
}

/** The one-tap answers a household member gives at settle time (REQ-008, AC-008.3). */
export interface TapAnswer {
  readonly id: string;
  readonly label: string;
}

export interface ChoreSpec {
  readonly title: string;
  /** Plain description of the chore for the judge prompt. */
  readonly judgeName: string;
  readonly tapAnswers: readonly TapAnswer[];
  /** The settle time of the rule quote, inside the chore's bounds (design.md, Settle-time bounds). */
  readonly ruleSettleAt: (nowMs: number) => number;
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
    ruleSettleAt: (nowMs) => madridWallTime(nowMs, 1, 8),
  },
};

/** How long a bet can be undone (AC-006.4); T-008 builds the undo itself. */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;
