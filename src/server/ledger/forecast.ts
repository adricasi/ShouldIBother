import { HOUR_MS, type ForecastHour } from "../../domain/weather.js";
import type { QuestionAnswer } from "../gemma/bookmaker.js";

import type { LedgerDeps } from "./deps.js";

/** How far ahead the forecast is read for a bookmaker run; the longest window is under 48 hours. */
export const FORECAST_HOURS = 48;
/** The same look-back the card creation uses, so the rule windows are covered (T-005). */
export const FORECAST_PAST_HOURS = 24;

/** The forecast hours from the current hour on, at most `hoursAhead` (what `get_forecast` serves). */
export function forecastFrom(
  hours: readonly ForecastHour[],
  nowMs: number,
  hoursAhead: number,
): ForecastHour[] {
  return hours.filter((hour) => hour.startsAt + HOUR_MS > nowMs).slice(0, hoursAhead);
}

/** Stored answers per card are capped here, whatever the caller does. */
export const MAX_STORED_ANSWERS = 3;

/** The yes/no taps stored on a card (`cards.gemma_answers`); anything malformed reads as none. */
export function parseAnswers(text: string): QuestionAnswer[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.slice(0, MAX_STORED_ANSWERS).flatMap((entry: unknown) => {
      const item = entry as { question?: unknown; yes?: unknown } | null;
      return typeof item?.question === "string" && typeof item.yes === "boolean"
        ? [{ question: item.question, yes: item.yes }]
        : [];
    });
  } catch {
    return [];
  }
}

/** True when the card has a bet that is not undone: its odds are locked. */
export function hasActiveBet(deps: Pick<LedgerDeps, "db">, cardId: number): boolean {
  return (
    deps.db
      .prepare<[number], { n: number }>(
        "SELECT COUNT(*) AS n FROM bets WHERE card_id = ? AND status != 'undone'",
      )
      .get(cardId)!.n > 0
  );
}
