import { LAUNDRY_PLAN, type InstantWindow } from "../../domain/chores.js";
import { planBetWindow } from "../../domain/laundry-plan.js";
import { WeatherUnavailableError, type RecordedWeather } from "../weather/client.js";

import { betLocationOf } from "./card-location.js";
import type { LedgerDeps } from "./deps.js";
import type { BetRow } from "./rows.js";

/** What the weather step needs from the ledger's dependencies. */
export type WeatherDeps = Pick<LedgerDeps, "db" | "now" | "weather">;

/** A bet that waits for recorded weather asks again at least this often (AC-014.5). */
export const RECORDED_WEATHER_RETRY_MS = 30 * 60 * 1000;

/** The weather a bet is judged on: from when it was placed to its settle time (AC-008.1). */
export function betWeatherWindow(bet: Pick<BetRow, "placed_at" | "settle_at">): InstantWindow {
  return { fromMs: bet.placed_at, toMs: bet.settle_at };
}

/**
 * The window a bet is judged on. A Skip today bet (REQ-021) is about the day the planner chose,
 * not the days between placing it and that day: its drying hours, 10:00 to 18:00 (AC-021.4).
 */
export function betJudgedWindow(db: WeatherDeps["db"], bet: BetRow): InstantWindow {
  const card = db
    .prepare<[number], { chore_type: string }>("SELECT chore_type FROM cards WHERE id = ?")
    .get(bet.card_id);
  return card?.chore_type === LAUNDRY_PLAN ? planBetWindow(bet.settle_at) : betWeatherWindow(bet);
}

/**
 * When a waiting bet was last tried, kept in `weather_cache` (row `recorded-attempt|<bet id>`)
 * so the 30 minutes hold across a restart and whoever tried last (the settlement or the scheduler).
 */
function attemptKey(betId: number): string {
  return `recorded-attempt|${betId}`;
}

function lastAttemptAt(db: WeatherDeps["db"], betId: number): number | undefined {
  return db
    .prepare<[string], { fetched_at: number }>("SELECT fetched_at FROM weather_cache WHERE key = ?")
    .get(attemptKey(betId))?.fetched_at;
}

function noteAttempt(db: WeatherDeps["db"], betId: number, nowMs: number): void {
  db.prepare(
    `INSERT INTO weather_cache (key, fetched_at, body) VALUES (?, ?, '{}')
     ON CONFLICT (key) DO UPDATE SET fetched_at = excluded.fetched_at`,
  ).run(attemptKey(betId), nowMs);
}

function forgetAttempt(db: WeatherDeps["db"], betId: number): void {
  db.prepare("DELETE FROM weather_cache WHERE key = ?").run(attemptKey(betId));
}

async function recordedFor(deps: WeatherDeps, bet: BetRow): Promise<RecordedWeather | undefined> {
  try {
    const recorded = await deps.weather.getRecorded({
      ...betJudgedWindow(deps.db, bet),
      ...betLocationOf(deps, bet.id),
    });
    return recorded.complete ? recorded : undefined;
  } catch (error) {
    if (error instanceof WeatherUnavailableError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Fetches the recorded weather of a due bet, for the settlement (AC-008.1). When it is not there
 * yet (or Open-Meteo is unreachable) the bet moves to `awaiting_weather` and keeps waiting
 * (AC-014.5); the scheduler asks again. Returns the weather when it is complete, else undefined.
 */
export async function collectRecordedWeather(
  deps: WeatherDeps,
  bet: BetRow,
): Promise<RecordedWeather | undefined> {
  noteAttempt(deps.db, bet.id, deps.now());
  const recorded = await recordedFor(deps, bet);
  if (recorded !== undefined) {
    forgetAttempt(deps.db, bet.id);
  }
  if (recorded === undefined && bet.status === "due") {
    deps.db
      .prepare("UPDATE bets SET status = 'awaiting_weather' WHERE id = ? AND status = 'due'")
      .run(bet.id);
  }
  return recorded;
}

/**
 * The scheduler's weather step: every bet in `awaiting_weather` is tried again once 30 minutes
 * have passed since its last try (AC-014.5). With the weather complete the bet moves on to
 * `awaiting_gemma`, where the judge picks it up. Returns how many bets moved on.
 */
export async function retryAwaitingWeather(deps: WeatherDeps): Promise<number> {
  const now = deps.now();
  const waiting = deps.db
    .prepare<[], BetRow>(
      "SELECT * FROM bets WHERE status = 'awaiting_weather' ORDER BY settle_at, id",
    )
    .all();
  let released = 0;
  for (const bet of waiting) {
    const last = lastAttemptAt(deps.db, bet.id);
    if (last !== undefined && now - last < RECORDED_WEATHER_RETRY_MS) {
      continue;
    }
    noteAttempt(deps.db, bet.id, now);
    if ((await recordedFor(deps, bet)) !== undefined) {
      released += deps.db
        .prepare(
          "UPDATE bets SET status = 'awaiting_gemma' WHERE id = ? AND status = 'awaiting_weather'",
        )
        .run(bet.id).changes;
      forgetAttempt(deps.db, bet.id);
    }
  }
  return released;
}
