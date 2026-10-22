import type { InstantWindow } from "../../domain/chores.js";
import { WeatherUnavailableError, type RecordedWeather } from "../weather/client.js";

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

/** When each waiting bet was last tried; in memory, so a restart simply tries again at once. */
export type WeatherAttempts = Map<number, number>;

async function recordedFor(deps: WeatherDeps, bet: BetRow): Promise<RecordedWeather | undefined> {
  try {
    const recorded = await deps.weather.getRecorded(betWeatherWindow(bet));
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
  attempts?: WeatherAttempts,
): Promise<RecordedWeather | undefined> {
  attempts?.set(bet.id, deps.now());
  const recorded = await recordedFor(deps, bet);
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
export async function retryAwaitingWeather(
  deps: WeatherDeps,
  attempts: WeatherAttempts,
): Promise<number> {
  const now = deps.now();
  const waiting = deps.db
    .prepare<[], BetRow>(
      "SELECT * FROM bets WHERE status = 'awaiting_weather' ORDER BY settle_at, id",
    )
    .all();
  let released = 0;
  for (const bet of waiting) {
    const last = attempts.get(bet.id);
    if (last !== undefined && now - last < RECORDED_WEATHER_RETRY_MS) {
      continue;
    }
    attempts.set(bet.id, now);
    if ((await recordedFor(deps, bet)) !== undefined) {
      released += deps.db
        .prepare(
          "UPDATE bets SET status = 'awaiting_gemma' WHERE id = ? AND status = 'awaiting_weather'",
        )
        .run(bet.id).changes;
      attempts.delete(bet.id);
    }
  }
  return released;
}
