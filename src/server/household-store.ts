import { roundCoordinate } from "../domain/open-meteo.js";

import { DEFAULT_LOCATION, householdSchema, type Household } from "./config.js";
import type { Db } from "./db.js";

/** Where onboarding stands: not answered yet, answered, or skipped (AC-024.1, AC-024.2). */
export type OnboardingState = "pending" | "completed" | "skipped";

interface Row {
  readonly status: "completed" | "skipped";
  readonly profile: string | null;
}

/**
 * The household behind the savings figures and the seasonal chores (REQ-024). The baseline is the
 * config file (`config/household.json`, A-6); a completed onboarding replaces it, a skipped or
 * unanswered one leaves it in force (AC-024.2). The answers live in the database, in the
 * household-private data folder, and never in a tracked file (NFR-002). Nothing is cached, so a
 * second reader (the weather client's location) sees a change at once. The savings snapshot of a
 * bet is written when it is placed, so a changed profile reaches only the bets placed afterwards.
 */
export class HouseholdStore {
  private warnedUnreadable = false;

  constructor(
    private readonly db: Db,
    /** The config-file baseline. */
    private readonly baseline: Household,
    private readonly now: () => number,
    /** Called once if a stored profile cannot be read; says that, never what the profile held. */
    private readonly warn: (entry: Readonly<Record<string, unknown>>) => void = () => undefined,
  ) {}

  private row(): Row | undefined {
    return this.db
      .prepare<[], Row>("SELECT status, profile FROM household_profile WHERE id = 1")
      .get();
  }

  state(): OnboardingState {
    return this.row()?.status ?? "pending";
  }

  /** The answers when onboarding was completed and they still parse, else the config baseline. */
  current(): Household {
    const row = this.row();
    if (row?.status !== "completed" || row.profile === null) {
      return this.baseline;
    }
    let parsed;
    try {
      parsed = householdSchema.safeParse(JSON.parse(row.profile));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success !== true) {
      // The baseline stays in force; one line says so, once per process, with no answer values.
      if (!this.warnedUnreadable) {
        this.warnedUnreadable = true;
        this.warn({ event: "household_profile_unreadable", fallback: "config baseline" });
      }
      return this.baseline;
    }
    return parsed.data;
  }

  /** What the form starts from: the answers or the baseline, location filled and rounded (2 decimals). */
  forForm(): Household {
    const household = this.current();
    const place = household.location ?? DEFAULT_LOCATION;
    return {
      ...household,
      location: {
        latitude: roundCoordinate(place.latitude),
        longitude: roundCoordinate(place.longitude),
      },
    };
  }

  /** Stores the answers; the location is kept at neighbourhood level (2 decimals, AC-014.1). */
  save(profile: Household): void {
    const stored: Household = {
      ...profile,
      ...(profile.location === undefined
        ? {}
        : {
            location: {
              latitude: roundCoordinate(profile.location.latitude),
              longitude: roundCoordinate(profile.location.longitude),
            },
          }),
    };
    this.write("completed", JSON.stringify(stored));
  }

  /** Records that the person skipped; the config baseline stays in force (AC-024.2). */
  skip(): void {
    this.write("skipped", null);
  }

  private write(status: Row["status"], profile: string | null): void {
    this.db
      .prepare(
        `INSERT INTO household_profile (id, status, profile, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, profile = excluded.profile,
           updated_at = excluded.updated_at`,
      )
      .run(status, profile, this.now());
  }
}
