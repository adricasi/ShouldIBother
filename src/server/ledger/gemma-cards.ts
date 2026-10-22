import { oddsOfBand } from "../../domain/bands.js";
import { isChoreType, type ChoreType } from "../../domain/chores.js";
import { bandTable, safetyAlert } from "../../domain/rules/index.js";
import { HOUR_MS, type ForecastHour } from "../../domain/weather.js";
import {
  bandOfName,
  distanceFromRule,
  runBookmaker,
  settleAtOf,
  type BookmakerInput,
  type QuestionAnswer,
} from "../gemma/bookmaker.js";
import { JobQueueFullError, type JobFailure } from "../gemma/runner.js";
import { HttpError } from "../problem.js";
import { WeatherUnavailableError } from "../weather/client.js";

import { ruleBandOrFallback, ruleQuoteAt, ruleWindowAt } from "./chore-rules.js";
import type { LedgerDeps } from "./deps.js";
import { cardPhotoView, currentObservations } from "./photo-view.js";
import { latestQuote } from "./quotes.js";
import type { CardRow, QuoteRow } from "./rows.js";
import { cardView, type CardView } from "./views.js";

export const FORECAST_HOURS = 48;
/** The same look-back the card creation uses, so the rule windows are covered (T-005). */
export const FORECAST_PAST_HOURS = 24;

/**
 * Why a card shows rule odds, stored on it: a runner failure or one of the card's own reasons
 * (`weather` no forecast, `restart` the process died, `busy` queue full, `superseded` a bet was
 * placed first, `unresolved` the question budget is spent).
 */
type CardFailure = JobFailure | "weather" | "restart" | "busy" | "superseded" | "unresolved";

/** A card asks at most this many questions; after that Gemma must answer or the rule odds stay. */
export const MAX_QUESTIONS_PER_CARD = 2;
/** Stored answers per card are capped here, whatever the caller does. */
const MAX_STORED_ANSWERS = 3;
/** The displayed reason is at most this long (design.md, Gemma jobs). */
const MAX_REASON_CHARS = 140;

/** The forecast hours from the current hour on, at most `hoursAhead` (what `get_forecast` serves). */
export function forecastFrom(
  hours: readonly ForecastHour[],
  nowMs: number,
  hoursAhead: number,
): ForecastHour[] {
  return hours.filter((hour) => hour.startsAt + HOUR_MS > nowMs).slice(0, hoursAhead);
}

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

export function hasActiveBet(deps: LedgerDeps, cardId: number): boolean {
  return (
    deps.db
      .prepare<[number], { n: number }>(
        "SELECT COUNT(*) AS n FROM bets WHERE card_id = ? AND status != 'undone'",
      )
      .get(cardId)!.n > 0
  );
}

/** Marks a card whose job finished without an answer: rule odds stay, Retry is offered. */
function markOffline(deps: LedgerDeps, cardId: number, failure: CardFailure): void {
  deps.db
    .prepare(
      `UPDATE cards SET gemma_state = 'offline', gemma_failure = ?, gemma_question = NULL
       WHERE id = ? AND gemma_state = 'thinking'`,
    )
    .run(failure, cardId);
}

function markQuestion(deps: LedgerDeps, cardId: number, question: string): void {
  deps.db
    .prepare(
      `UPDATE cards SET gemma_state = 'question', gemma_failure = NULL, gemma_question = ?
       WHERE id = ? AND gemma_state = 'thinking'`,
    )
    .run(question.trim(), cardId);
}

/**
 * The bookmaker for one card, from the forecast to the swap of the rule quote for Gemma's
 * (REQ-003, REQ-013). Always ends with the card out of `thinking`, so the UI never waits forever.
 */
async function bookmakeCard(deps: LedgerDeps, cardId: number): Promise<void> {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined || card.kind !== "weather" || !isChoreType(card.chore_type)) {
    return;
  }
  const choreType: ChoreType = card.chore_type;
  const ruleRow = deps.db
    .prepare<[number], QuoteRow>(
      "SELECT * FROM quotes WHERE card_id = ? AND source = 'rule' ORDER BY id DESC LIMIT 1",
    )
    .get(cardId);
  if (ruleRow === undefined) {
    markOffline(deps, cardId, "invalid");
    return;
  }

  const seen = currentObservations(deps.db, cardId);
  // The job's 45 s deadline starts here, before the forecast is fetched. `nowMs` is the real
  // time; settle bounds and rule windows hang on the card's own creation time instead.
  const enqueuedAt = deps.now();
  const nowMs = enqueuedAt;
  const anchorMs = card.created_at;
  let hours: readonly ForecastHour[];
  try {
    hours = (
      await deps.weather.getForecast({
        fromMs: nowMs,
        hours: FORECAST_HOURS,
        pastHours: FORECAST_PAST_HOURS,
      })
    ).hours;
  } catch (error) {
    if (error instanceof WeatherUnavailableError) {
      markOffline(deps, cardId, "weather");
      return;
    }
    throw error;
  }

  const input: BookmakerInput = {
    chore: choreType,
    label: card.input_text,
    nowMs,
    anchorMs,
    ruleBand: ruleRow.band,
    ruleBandAt: (settleAtMs) =>
      ruleBandOrFallback(choreType, hours, anchorMs, settleAtMs, deps.rules, ruleRow.band),
    answers: parseAnswers(card.gemma_answers),
    readForecast: (hoursAhead) => Promise.resolve(forecastFrom(hours, nowMs, hoursAhead)),
    cardId,
    enqueuedAt,
    // A re-run (Retry, a tap on Gemma's question) still reads the card's photo (REQ-005).
    ...(seen === undefined ? {} : { observations: seen.observations, photoId: seen.photoId }),
  };
  let result;
  try {
    result = await runBookmaker(deps.gemma, input);
  } catch (error) {
    if (error instanceof JobQueueFullError) {
      markOffline(deps, cardId, "busy");
      return;
    }
    throw error;
  }
  if (!result.ok) {
    markOffline(deps, cardId, result.failure);
    return;
  }
  const { output } = result;
  // A card does not loop on questions: after the budget Gemma must answer, or the rule odds stay.
  const mayAsk = input.answers.length < MAX_QUESTIONS_PER_CARD;
  if (output.status === "unsure") {
    if (mayAsk) {
      markQuestion(deps, cardId, output.question ?? "");
    } else {
      markOffline(deps, cardId, "unresolved");
    }
    return;
  }

  // From here the answer passed `bookmakerCheck`: band, reason and settle time are present.
  const band = bandOfName(output.band!);
  const settleAt = settleAtOf(choreType, anchorMs, nowMs, output.settle_in_hours!);
  const farFromRule = (distanceFromRule(input, output) ?? 0) >= 2;
  const explained = (output.disagreement_reason ?? "").trim() !== "";
  if (farFromRule && !explained) {
    // Two or more bands from the rule with a question and no explanation: ask the person
    // (AC-004.3) instead of showing an unexplained disagreement; once the questions are spent
    // the rule odds stay.
    if (mayAsk) {
      markQuestion(deps, cardId, output.question ?? "");
    } else {
      markOffline(deps, cardId, "unresolved");
    }
    return;
  }

  // The fixed backstop also covers the window Gemma settled on: if heat, frost or storm shows
  // up there, the card becomes a "Do it now" alert instead of getting Gemma's odds (AC-012.1).
  const finalWindow = ruleWindowAt(choreType, anchorMs, settleAt);
  const alert = safetyAlert(hours, finalWindow.fromMs, finalWindow.toMs, deps.rules);
  const table = bandTable(deps.rules);
  // One line of at most 140 characters: the reason, then (cut if need be) why it differs.
  const joined = explained
    ? `${output.reason ?? ""} Differs from the rule: ${output.disagreement_reason!.trim()}`
    : (output.reason ?? "");
  const reason =
    joined.length <= MAX_REASON_CHARS ? joined : `${joined.slice(0, MAX_REASON_CHARS - 1)}…`;
  const swap = deps.db.transaction((): void => {
    const fresh = deps.db
      .prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?")
      .get(cardId);
    if (fresh?.gemma_state !== "thinking") {
      return;
    }
    if (hasActiveBet(deps, cardId)) {
      // A bet is locked to the odds its person saw: a late answer does not touch it (AC-006.2).
      // The card reads "offline" with Retry, so if the bet is undone Retry works.
      deps.db
        .prepare(
          `UPDATE cards SET gemma_state = 'offline', gemma_failure = 'superseded',
             gemma_question = NULL WHERE id = ?`,
        )
        .run(cardId);
      return;
    }
    if (alert !== null) {
      deps.db
        .prepare(
          `UPDATE cards SET kind = 'alert', alert_reason = ?, gemma_state = NULL,
             gemma_failure = NULL, gemma_question = NULL WHERE id = ?`,
        )
        .run(alert.reason, cardId);
      deps.log({ event: "alert_on_final_window", cardId });
      return;
    }
    const createdAt = deps.now();
    if (settleAt !== ruleRow.settle_at) {
      // Gemma moved the settle time: the rule band is stored for the final window (AC-004.2).
      const rule = ruleQuoteAt(choreType, hours, anchorMs, settleAt, deps.rules);
      if (rule === null) {
        // The forecast does not reach the final window: the card keeps its original rule quote,
        // so a bet's `rule_band` is the original window's band. Logged, not hidden.
        deps.log({ event: "rule_band_fallback", cardId, reason: "forecast short of final window" });
      } else {
        deps.db
          .prepare(
            `INSERT INTO quotes (card_id, source, band, odds, with_photo, reason, settle_at, created_at)
             VALUES (?, 'rule', ?, ?, 0, ?, ?, ?)`,
          )
          .run(cardId, rule.band, oddsOfBand(table, rule.band), rule.reason, settleAt, createdAt);
      }
    }
    // The photo may have been deleted while Gemma worked: then the quote is made without it.
    const photoId =
      seen !== undefined &&
      deps.db.prepare("SELECT 1 FROM photos WHERE id = ?").get(seen.photoId) !== undefined
        ? seen.photoId
        : null;
    deps.db
      .prepare(
        `INSERT INTO quotes (card_id, source, band, odds, with_photo, photo_id, reason, settle_at,
           decision_id, created_at)
         VALUES (?, 'gemma', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cardId,
        band,
        oddsOfBand(table, band),
        photoId === null ? 0 : 1,
        photoId,
        reason,
        settleAt,
        result.decisionId,
        createdAt,
      );
    deps.db
      .prepare(
        `UPDATE cards SET gemma_state = 'answered', gemma_failure = NULL, gemma_question = NULL
         WHERE id = ?`,
      )
      .run(cardId);
  });
  swap();
}

/**
 * Starts the bookmaker for a card in the background. The card must already be `thinking`; the
 * response to the person does not wait for Gemma (AC-013.1).
 */
export function launchBookmaker(deps: LedgerDeps, cardId: number): void {
  deps.background.track(
    bookmakeCard(deps, cardId).catch((error: unknown) => {
      // Never leave a card thinking: show rule odds and Retry, then let the caller log the error.
      markOffline(deps, cardId, "internal");
      throw error;
    }),
  );
}

/** 503 "busy": work that needs Gemma now is refused when its queue is full, not piled up. */
export function gemmaBusy(): HttpError {
  return new HttpError(
    503,
    "Gemma is busy",
    "Too many requests are waiting for Gemma. Try again in a minute.",
  );
}

export function assertGemmaCapacity(deps: Pick<LedgerDeps, "gemma">): void {
  if (deps.gemma.full) {
    throw gemmaBusy();
  }
}

function requireCard(deps: LedgerDeps, cardId: number): CardRow {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  if (card === undefined) {
    throw new HttpError(404, "Card not found");
  }
  if (card.kind !== "weather") {
    throw new HttpError(409, "This card has no odds");
  }
  const quote = latestQuote(deps, cardId);
  if (quote === undefined || quote.settle_at <= deps.now()) {
    throw new HttpError(409, "These odds are out of date", "Create a new card.");
  }
  if (hasActiveBet(deps, cardId)) {
    throw new HttpError(409, "A bet is already placed on this card");
  }
  return card;
}

function viewOf(deps: LedgerDeps, cardId: number): CardView {
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId)!;
  const table = bandTable(deps.rules);
  return cardView(card, latestQuote(deps, cardId), table, cardPhotoView(deps.db, card, table));
}

/**
 * Retry after "Gemma offline · rule odds" (AC-013.3). Cards from before migration 0005 have no
 * state and count as offline. A card that is thinking or waiting for a tap is left alone.
 */
export function retryCard(deps: LedgerDeps, cardId: number): CardView {
  const card = requireCard(deps, cardId);
  if (card.gemma_state !== null && card.gemma_state !== "offline") {
    throw new HttpError(409, "Gemma is already working on this card");
  }
  assertGemmaCapacity(deps);
  const moved = deps.db
    .prepare(
      `UPDATE cards SET gemma_state = 'thinking', gemma_failure = NULL
       WHERE id = ? AND (gemma_state IS NULL OR gemma_state = 'offline')`,
    )
    .run(cardId).changes;
  if (moved === 1) {
    launchBookmaker(deps, cardId);
  }
  return viewOf(deps, cardId);
}

/** The person's yes/no tap on Gemma's question: remember it and ask the bookmaker again (AC-003.3). */
export function answerCard(deps: LedgerDeps, cardId: number, yes: boolean): CardView {
  const card = requireCard(deps, cardId);
  if (card.gemma_state !== "question" || card.gemma_question === null) {
    throw new HttpError(409, "Gemma has no question on this card");
  }
  const stored = parseAnswers(card.gemma_answers);
  if (stored.length >= MAX_STORED_ANSWERS) {
    throw new HttpError(409, "Gemma has asked enough questions on this card");
  }
  assertGemmaCapacity(deps);
  const answers = [...stored, { question: card.gemma_question, yes }];
  const moved = deps.db
    .prepare(
      `UPDATE cards SET gemma_state = 'thinking', gemma_question = NULL, gemma_failure = NULL,
         gemma_answers = ?
       WHERE id = ? AND gemma_state = 'question'`,
    )
    .run(JSON.stringify(answers), cardId).changes;
  if (moved === 1) {
    launchBookmaker(deps, cardId);
  }
  return viewOf(deps, cardId);
}

/**
 * On start, a card still `thinking` lost its job with the previous process: it shows rule odds
 * and Retry instead of waiting forever (NFR-003).
 */
export function recoverThinkingCards(deps: Pick<LedgerDeps, "db">): number {
  return deps.db
    .prepare(
      `UPDATE cards SET gemma_state = 'offline', gemma_failure = 'restart'
       WHERE gemma_state = 'thinking'`,
    )
    .run().changes;
}
