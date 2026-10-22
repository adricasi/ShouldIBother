import { oddsOfBand } from "../../domain/bands.js";
import { isChoreType, type ChoreType } from "../../domain/chores.js";
import { bandTable } from "../../domain/rules/index.js";
import type { ForecastHour } from "../../domain/weather.js";
import {
  bandOfName,
  distanceFromRule,
  runBookmaker,
  settleAtOf,
  type BookmakerInput,
} from "../gemma/bookmaker.js";
import { runInspector, type Observation } from "../gemma/inspector.js";
import type { JobFailure } from "../gemma/runner.js";
import { WeatherUnavailableError } from "../weather/client.js";

import { ruleBandOrFallback, ruleQuoteAt } from "./chore-rules.js";
import type { LedgerDeps } from "./deps.js";
import {
  FORECAST_HOURS,
  FORECAST_PAST_HOURS,
  forecastFrom,
  hasActiveBet,
  parseAnswers,
} from "./gemma-cards.js";
import type { PhotoRow } from "./photos.js";
import type { CardRow, QuoteRow } from "./rows.js";

/** Stored in `cards.photo_failure` besides the runner's failure codes. */
export type PhotoFailure = JobFailure | "weather" | "restart" | "odds_kept" | "file";

type InspectDeps = LedgerDeps;

function setPhotoState(
  deps: Pick<LedgerDeps, "db">,
  cardId: number,
  state: "seen" | "unsure" | "failed",
  failure: PhotoFailure | null,
): void {
  // Only while the photo is still being inspected: a deleted photo reset the state to NULL.
  deps.db
    .prepare(
      `UPDATE cards SET photo_state = ?, photo_failure = ?
       WHERE id = ? AND photo_state = 'inspecting'`,
    )
    .run(state, failure, cardId);
}

/**
 * Marks the card as being inspected and starts the inspector and the bookmaker in the background
 * (AC-005.2). The response to the person does not wait for Gemma; the card is polled until
 * `photo.state` is no longer `inspecting`.
 */
export function startInspection(deps: InspectDeps, cardId: number, photoId: string): void {
  deps.db
    .prepare("UPDATE cards SET photo_state = 'inspecting', photo_failure = NULL WHERE id = ?")
    .run(cardId);
  deps.background.track(
    inspectPhoto(deps, cardId, photoId).catch((error: unknown) => {
      // Never leave a card inspecting: the odds stay as they were, then let the caller log it.
      setPhotoState(deps, cardId, "failed", "invalid");
      throw error;
    }),
  );
}

/**
 * The inspector reads the photo, then the bookmaker is asked again with what it saw. Both share
 * the one 45 s deadline of the photo, measured from here (requirements.md, fixed values). Every
 * way out leaves the odds the card already had unless the bookmaker answers with the photo
 * (AC-005.3, AC-005.4); a with-photo answer is a new quote, so the old odds stay in the table
 * for "before → after" and for the bet's band without the photo (AC-005.5).
 */
async function inspectPhoto(deps: InspectDeps, cardId: number, photoId: string): Promise<void> {
  const enqueuedAt = deps.now();
  const card = deps.db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(cardId);
  const photo = deps.db
    .prepare<[string], PhotoRow>("SELECT * FROM photos WHERE id = ?")
    .get(photoId);
  if (card === undefined || photo === undefined || !isChoreType(card.chore_type)) {
    return;
  }
  const choreType: ChoreType = card.chore_type;
  let image: Buffer;
  try {
    image = deps.photos.read(photo.file);
  } catch {
    setPhotoState(deps, cardId, "failed", "file");
    return;
  }

  const inspected = await runInspector(deps.gemma, {
    chore: choreType,
    image,
    width: photo.width,
    height: photo.height,
    cardId,
    photoId,
    enqueuedAt,
  });
  if (!inspected.ok) {
    setPhotoState(deps, cardId, "failed", inspected.failure);
    return;
  }
  if (inspected.output.status === "unsure") {
    // AC-005.4: the odds without the photo stay; the question is shown with the card.
    setPhotoState(deps, cardId, "unsure", null);
    return;
  }
  await bookmakeWithPhoto(deps, card, choreType, photoId, inspected.output.observations ?? [], {
    enqueuedAt,
  });
}

async function bookmakeWithPhoto(
  deps: InspectDeps,
  card: CardRow,
  choreType: ChoreType,
  photoId: string,
  observations: readonly Observation[],
  options: { enqueuedAt: number },
): Promise<void> {
  const cardId = card.id;
  const ruleRow = deps.db
    .prepare<[number], QuoteRow>(
      "SELECT * FROM quotes WHERE card_id = ? AND source = 'rule' ORDER BY id DESC LIMIT 1",
    )
    .get(cardId);
  if (ruleRow === undefined) {
    setPhotoState(deps, cardId, "seen", "odds_kept");
    return;
  }
  const nowMs = deps.now();
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
      setPhotoState(deps, cardId, "seen", "weather");
      return;
    }
    throw error;
  }
  const input: BookmakerInput = {
    chore: choreType,
    label: card.input_text,
    nowMs,
    ruleBand: ruleRow.band,
    ruleBandAt: (settleAtMs) =>
      ruleBandOrFallback(choreType, hours, nowMs, settleAtMs, deps.rules, ruleRow.band),
    answers: parseAnswers(card.gemma_answers),
    readForecast: (hoursAhead) => Promise.resolve(forecastFrom(hours, nowMs, hoursAhead)),
    cardId,
    observations,
    photoId,
    enqueuedAt: options.enqueuedAt,
  };
  const result = await runBookmaker(deps.gemma, input);
  if (!result.ok) {
    setPhotoState(deps, cardId, "seen", result.failure);
    return;
  }
  const { output } = result;
  const explained = (output.disagreement_reason ?? "").trim() !== "";
  const farFromRule = (distanceFromRule(input, output) ?? 0) >= 2;
  if (output.status !== "ok" || (farFromRule && !explained)) {
    // A question or an unexplained disagreement: keep the odds without the photo (AC-005.4).
    setPhotoState(deps, cardId, "seen", "odds_kept");
    return;
  }

  const band = bandOfName(output.band!);
  const settleAt = settleAtOf(choreType, nowMs, output.settle_in_hours!);
  const table = bandTable(deps.rules);
  const reason = explained
    ? `${output.reason ?? ""} Differs from the rule: ${output.disagreement_reason!.trim()}`
    : (output.reason ?? "");
  deps.db.transaction((): void => {
    const stillThere = deps.db
      .prepare<[number, string], { id: number }>(
        `SELECT c.id FROM cards c JOIN photos p ON p.card_id = c.id
         WHERE c.id = ? AND p.id = ? AND c.photo_state = 'inspecting'`,
      )
      .get(cardId, photoId);
    if (stillThere === undefined || hasActiveBet(deps, cardId)) {
      // The photo was deleted meanwhile, or a bet locked the odds the person saw (AC-006.2).
      deps.db
        .prepare(
          "UPDATE cards SET photo_state = 'seen', photo_failure = 'odds_kept' WHERE id = ? AND photo_state = 'inspecting'",
        )
        .run(cardId);
      return;
    }
    const createdAt = deps.now();
    if (settleAt !== ruleRow.settle_at) {
      // The rule band is stored for the final settle window (AC-004.2), as for the first answer.
      const rule = ruleQuoteAt(choreType, hours, nowMs, settleAt, deps.rules);
      if (rule !== null) {
        deps.db
          .prepare(
            `INSERT INTO quotes (card_id, source, band, odds, with_photo, reason, settle_at, created_at)
             VALUES (?, 'rule', ?, ?, 0, ?, ?, ?)`,
          )
          .run(cardId, rule.band, oddsOfBand(table, rule.band), rule.reason, settleAt, createdAt);
      }
    }
    deps.db
      .prepare(
        `INSERT INTO quotes (card_id, source, band, odds, with_photo, photo_id, reason, settle_at,
           decision_id, created_at)
         VALUES (?, 'gemma', ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        cardId,
        band,
        oddsOfBand(table, band),
        photoId,
        reason,
        settleAt,
        result.decisionId,
        createdAt,
      );
    deps.db
      .prepare(
        "UPDATE cards SET photo_state = 'seen', photo_failure = NULL WHERE id = ? AND photo_state = 'inspecting'",
      )
      .run(cardId);
  })();
}

/**
 * On start, a card still `inspecting` lost its job with the previous process: its photo shows as
 * failed and the odds stay as they were (NFR-003).
 */
export function recoverInspections(deps: Pick<LedgerDeps, "db">): number {
  return deps.db
    .prepare(
      `UPDATE cards SET photo_state = 'failed', photo_failure = 'restart'
       WHERE photo_state = 'inspecting'`,
    )
    .run().changes;
}
