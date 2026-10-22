import type { ChoreType } from "./chores.js";

/** The dryer types of the household baseline (`config/household.json`, A-6). */
export const DRYER_TYPES = ["heat-pump", "condenser", "vented", "none"] as const;
export type Dryer = (typeof DRYER_TYPES)[number];

/** App time per bet or do-it decision, for capture and settlement (AC-011.3). */
export const APP_SECONDS_PER_BET = 30;

/** Where a figure comes from; shown with it (AC-011.5). */
export const FIGURE_BASES = ["sourced", "typical estimate", "household baseline"] as const;
export type FigureBasis = (typeof FIGURE_BASES)[number];

/** What one won bet saves, with the assumption behind it (docs/discovery/product-concept.md). */
export interface SavingsFigure {
  /** Minutes of skipped steps only: hanging laundry instead of the dryer is 0 (AC-011.4). */
  readonly time_min: number;
  readonly water_l: number;
  readonly electricity_kwh: number;
  /** One line shown wherever the figure is shown, e.g. "vs a heat-pump dryer, ~2.2 kWh". */
  readonly assumption: string;
  readonly basis: FigureBasis;
  /** A link for a sourced figure. */
  readonly source?: string | undefined;
}

/**
 * The catalogue by chore. Line-dry today saves the dryer's electricity, so its figure depends on
 * the household's dryer; every other chore has one figure.
 */
export type SavingsCatalogue = Readonly<
  Record<Exclude<ChoreType, "laundry_line">, SavingsFigure>
> & { readonly laundry_line: Readonly<Record<Dryer, SavingsFigure>> };

/**
 * The figure written on a bet when it is placed (design.md, Points and savings): the catalogue
 * figure for the chore and the household baseline of that moment. It never changes afterwards.
 */
export interface SavingsSnapshot extends SavingsFigure {
  readonly version: 1;
  readonly chore_type: ChoreType;
}

export function snapshotFor(
  catalogue: SavingsCatalogue,
  choreType: ChoreType,
  baseline: { readonly dryer: Dryer },
): SavingsSnapshot {
  const figure =
    choreType === "laundry_line" ? catalogue.laundry_line[baseline.dryer] : catalogue[choreType];
  return { version: 1, chore_type: choreType, ...figure };
}

/** Reads a stored snapshot; null for a bet without one or with text this code does not know. */
export function parseSnapshot(text: string | null): SavingsSnapshot | null {
  if (text === null) {
    return null;
  }
  try {
    const value = JSON.parse(text) as Partial<SavingsSnapshot> | null;
    if (
      value !== null &&
      typeof value === "object" &&
      value.version === 1 &&
      typeof value.time_min === "number" &&
      typeof value.water_l === "number" &&
      typeof value.electricity_kwh === "number" &&
      typeof value.assumption === "string"
    ) {
      return value as SavingsSnapshot;
    }
  } catch {
    // unreadable text counts as no snapshot
  }
  return null;
}

/** One assumption shown next to the totals, with how many won bets it covers. */
export interface SavingsAssumption {
  readonly chore_type: ChoreType;
  readonly assumption: string;
  readonly basis: FigureBasis;
  readonly wins: number;
}

export interface SavingsTotals {
  /** Bets placed and not undone in the period (do-nothing bets and do-it decisions). */
  readonly bets: number;
  readonly wins: number;
  readonly time_saved_s: number;
  /** 30 s per bet (AC-011.3). */
  readonly app_time_s: number;
  /** Saved minus spent; can be negative. */
  readonly net_time_s: number;
  readonly water_l: number;
  readonly electricity_kwh: number;
  readonly assumptions: readonly SavingsAssumption[];
}

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Totals over won do-nothing bets only (AC-011.1, AC-011.2); `betsPlaced` is every bet and do-it
 * decision placed and not undone, which costs the app time (AC-011.3).
 */
export function totalSavings(
  wins: readonly (SavingsSnapshot | null)[],
  betsPlaced: number,
): SavingsTotals {
  let minutes = 0;
  let water = 0;
  let kwh = 0;
  const assumptions = new Map<string, SavingsAssumption>();
  for (const snapshot of wins) {
    if (snapshot === null) {
      continue;
    }
    minutes += snapshot.time_min;
    water += snapshot.water_l;
    kwh += snapshot.electricity_kwh;
    const key = `${snapshot.chore_type}|${snapshot.assumption}`;
    const seen = assumptions.get(key);
    assumptions.set(key, {
      chore_type: snapshot.chore_type,
      assumption: snapshot.assumption,
      basis: snapshot.basis,
      wins: (seen?.wins ?? 0) + 1,
    });
  }
  const timeSavedS = Math.round(minutes * 60);
  const appTimeS = betsPlaced * APP_SECONDS_PER_BET;
  return {
    bets: betsPlaced,
    wins: wins.length,
    time_saved_s: timeSavedS,
    app_time_s: appTimeS,
    net_time_s: timeSavedS - appTimeS,
    water_l: round(water, 1),
    electricity_kwh: round(kwh, 2),
    assumptions: [...assumptions.values()],
  };
}
