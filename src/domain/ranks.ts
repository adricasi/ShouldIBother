/**
 * Ranks and achievements (REQ-025). Both are computed by code from settled data: Gemma never
 * decides points, ranks or unlocks. Pure functions, no I/O.
 */

/** A rank starts at `minPoints` (included) and lasts until the next rank's `minPoints`. */
export interface Rank {
  readonly id: string;
  readonly name: string;
  readonly minPoints: number;
}

/** AC-025.1: Hyperactive squirrel (0), Koala (200), Three-toed sloth (600), Grand master of inaction (1,800). */
export const RANKS: readonly Rank[] = [
  { id: "hyperactive_squirrel", name: "Hyperactive squirrel", minPoints: 0 },
  { id: "koala", name: "Koala", minPoints: 200 },
  { id: "three_toed_sloth", name: "Three-toed sloth", minPoints: 600 },
  { id: "grand_master_of_inaction", name: "Grand master of inaction", minPoints: 1800 },
];

export interface RankStanding {
  readonly id: string;
  readonly name: string;
  readonly min_points: number;
  /** The next rank and the points still missing, or null at the top. */
  readonly next: {
    readonly name: string;
    readonly min_points: number;
    readonly points_to_go: number;
  } | null;
}

/**
 * The rank for a points total. The total can be negative (losses are not floored), which is still
 * the first rank. Thresholds include their lower bound: exactly 200 points is a Koala.
 */
export function rankFor(points: number): RankStanding {
  let index = 0;
  for (const [candidate, rank] of RANKS.entries()) {
    if (points >= rank.minPoints) {
      index = candidate;
    }
  }
  const current = RANKS[index]!;
  const next = RANKS[index + 1];
  return {
    id: current.id,
    name: current.name,
    min_points: current.minPoints,
    next:
      next === undefined
        ? null
        : { name: next.name, min_points: next.minPoints, points_to_go: next.minPoints - points },
  };
}

export type AchievementId =
  "first_nap" | "cloud_whisperer" | "sky_freeloader" | "knows_when_to_fold";

export interface AchievementDefinition {
  readonly id: AchievementId;
  readonly name: string;
  /** The condition in plain words, shown next to the achievement. */
  readonly condition: string;
}

/** AC-025.2, in the order the Score screen lists them. */
export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  { id: "first_nap", name: "First nap", condition: "Win your first bet" },
  { id: "cloud_whisperer", name: "Cloud whisperer", condition: "Win a bet at odds of 40% or less" },
  { id: "sky_freeloader", name: "Sky freeloader", condition: "Win three bets in a row" },
  {
    id: "knows_when_to_fold",
    name: "Knows when to fold",
    condition: "Cash out for the first time",
  },
];

/** Highest odds (percent) that still counts as a long shot for Cloud whisperer. */
export const CLOUD_WHISPERER_MAX_ODDS = 40;

/** Wins in a row for Sky freeloader. */
export const FREELOADER_STREAK = 3;

/**
 * How a bet on doing nothing ended. A loss of any size and a cash-out both end a streak; a do-it
 * decision is not a bet on doing nothing and is not in the list.
 */
export type BetResult =
  | { readonly kind: "win"; readonly at: number; readonly odds: number }
  | { readonly kind: "loss"; readonly at: number }
  | { readonly kind: "cash_out"; readonly at: number };

/**
 * The achievements earned by a history, each with the time its condition was first met. `results`
 * must be in the order the bets ended; later results never move an earlier unlock.
 */
export function earnedAchievements(
  results: readonly BetResult[],
): ReadonlyMap<AchievementId, number> {
  const earned = new Map<AchievementId, number>();
  let streak = 0;
  for (const result of results) {
    if (result.kind === "win") {
      streak += 1;
      if (!earned.has("first_nap")) {
        earned.set("first_nap", result.at);
      }
      if (result.odds <= CLOUD_WHISPERER_MAX_ODDS && !earned.has("cloud_whisperer")) {
        earned.set("cloud_whisperer", result.at);
      }
      if (streak >= FREELOADER_STREAK && !earned.has("sky_freeloader")) {
        earned.set("sky_freeloader", result.at);
      }
    } else {
      streak = 0;
      if (result.kind === "cash_out" && !earned.has("knows_when_to_fold")) {
        earned.set("knows_when_to_fold", result.at);
      }
    }
  }
  return earned;
}
