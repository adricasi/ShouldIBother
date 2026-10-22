import type { Db } from "../db.js";
import { oddsOfBand } from "../../domain/bands.js";
import { isChoreType, type ChoreType } from "../../domain/chores.js";
import { bandTable, safetyAlert } from "../../domain/rules/index.js";
import type { ForecastHour } from "../../domain/weather.js";
import {
  bandOfName,
  distanceFromRule,
  runBookmaker,
  settleAtOf,
  type BookmakerInput,
} from "../gemma/bookmaker.js";
import { runInspector, type Observation } from "../gemma/inspector.js";
import { JobQueueFullError, type JobFailure } from "../gemma/runner.js";
import { WeatherUnavailableError } from "../weather/client.js";

import { ruleBandOrFallback, ruleQuoteAt, ruleWindowAt } from "./chore-rules.js";
import type { LedgerDeps } from "./deps.js";
import {
  FORECAST_HOURS,
  FORECAST_PAST_HOURS,
  forecastFrom,
  hasActiveBet,
  parseAnswers,
} from "./forecast.js";
import { turnIntoAlert } from "./gemma-cards.js";
import { inspectorRead } from "./photo-view.js";
import type { PhotoRow } from "./photos.js";
import type { CardRow, QuoteRow } from "./rows.js";

/** Stored in `cards.photo_failure` besides the runner's failure codes. */
export type PhotoFailure =
  JobFailure | "weather" | "restart" | "odds_kept" | "file" | "busy" | "superseded";

type InspectDeps = LedgerDeps;

/** SQL that is true while `?` (a photo id) is still the photo of the card being updated. */
const PHOTO_IS_CURRENT = "EXISTS (SELECT 1 FROM photos WHERE id = ? AND card_id = cards.id)";

/** True while `photoId` is still the photo of a weather card that is being inspected. */
function photoIsCurrent(db: Pick<Db, "prepare">, cardId: number, photoId: string): boolean {
  return (
    db
      .prepare<[number, string], { id: number }>(
        `SELECT id FROM cards
         WHERE id = ? AND kind = 'weather' AND photo_state = 'inspecting' AND ${PHOTO_IS_CURRENT}`,
      )
      .get(cardId, photoId) !== undefined
  );
}

/**
 * Records where the inspection ended, but only while the job's own photo is still the card's
 * photo and still being inspected. A photo deleted or replaced meanwhile makes the job stale: its
 * result is dropped, and a newer photo's state is never touched.
 */
function setPhotoState(
  deps: Pick<LedgerDeps, "db">,
  cardId: number,
  photoId: string,
  state: "seen" | "unsure" | "failed",
  failure: PhotoFailure | null,
): void {
  deps.db
    .prepare(
      `UPDATE cards SET photo_state = ?, photo_failure = ?
       WHERE id = ? AND photo_state = 'inspecting' AND ${PHOTO_IS_CURRENT}`,
    )
    .run(state, failure, cardId, photoId);
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
      // Never leave a card inspecting, and keep what the inspector already read: the odds stay as
      // they were. The caller logs the real error.
      const read = inspectorRead(deps.db, photoId);
      setPhotoState(
        deps,
        cardId,
        photoId,
        read?.status === "ok" ? "seen" : read?.status === "unsure" ? "unsure" : "failed",
        "internal",
      );
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
    setPhotoState(deps, cardId, photoId, "failed", "file");
    return;
  }

  let inspected;
  try {
    inspected = await runInspector(deps.gemma, {
      chore: choreType,
      image,
      width: photo.width,
      height: photo.height,
      cardId,
      photoId,
      enqueuedAt,
    });
  } catch (error) {
    if (error instanceof JobQueueFullError) {
      setPhotoState(deps, cardId, photoId, "failed", "busy");
      return;
    }
    throw error;
  }
  if (!photoIsCurrent(deps.db, cardId, photoId)) {
    // Deleted or replaced while Gemma looked: nothing from this job is used.
    return;
  }
  if (!inspected.ok) {
    setPhotoState(deps, cardId, photoId, "failed", inspected.failure);
    return;
  }
  if (inspected.output.status === "unsure") {
    // AC-005.4: the odds without the photo stay; the question is shown with the card.
    setPhotoState(deps, cardId, photoId, "unsure", null);
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
    setPhotoState(deps, cardId, photoId, "seen", "odds_kept");
    return;
  }
  const nowMs = deps.now();
  const anchorMs = card.created_at;
  const sunsetMs = card.sunset_at ?? undefined;
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
      setPhotoState(deps, cardId, photoId, "seen", "weather");
      return;
    }
    throw error;
  }
  const input: BookmakerInput = {
    chore: choreType,
    label: card.input_text,
    nowMs,
    // Settle bounds and rule windows hang on the card's creation time, as for the first answer.
    anchorMs,
    ruleBand: ruleRow.band,
    ruleBandAt: (settleAtMs) =>
      ruleBandOrFallback(
        choreType,
        hours,
        anchorMs,
        settleAtMs,
        deps.rules,
        ruleRow.band,
        sunsetMs,
      ),
    answers: parseAnswers(card.gemma_answers),
    readForecast: (hoursAhead) => Promise.resolve(forecastFrom(hours, nowMs, hoursAhead)),
    cardId,
    observations,
    photoId,
    enqueuedAt: options.enqueuedAt,
  };
  let result;
  try {
    result = await runBookmaker(deps.gemma, input);
  } catch (error) {
    if (error instanceof JobQueueFullError) {
      setPhotoState(deps, cardId, photoId, "seen", "busy");
      return;
    }
    throw error;
  }
  if (!result.ok) {
    setPhotoState(deps, cardId, photoId, "seen", result.failure);
    return;
  }
  const { output } = result;
  const explained = (output.disagreement_reason ?? "").trim() !== "";
  const farFromRule = (distanceFromRule(input, output) ?? 0) >= 2;
  if (output.status !== "ok" || (farFromRule && !explained)) {
    // A question or an unexplained disagreement: keep the odds without the photo (AC-005.4).
    setPhotoState(deps, cardId, photoId, "seen", "odds_kept");
    return;
  }

  const band = bandOfName(output.band!);
  const settleAt = settleAtOf(choreType, anchorMs, nowMs, output.settle_in_hours!);
  const table = bandTable(deps.rules);
  const reason = explained
    ? `${output.reason ?? ""} Differs from the rule: ${output.disagreement_reason!.trim()}`
    : (output.reason ?? "");
  // The fixed backstop also covers the window the answer settles on (AC-012.1), as for the first
  // answer; decided inside the transaction below, once the photo is known to be current.
  const finalWindow = ruleWindowAt(choreType, anchorMs, settleAt, sunsetMs);
  const alert = safetyAlert(hours, finalWindow.fromMs, finalWindow.toMs, deps.rules);

  deps.db.transaction((): void => {
    if (!photoIsCurrent(deps.db, cardId, photoId)) {
      // The photo was deleted or replaced meanwhile: this job is stale, its answer is dropped.
      return;
    }
    const kind = deps.db
      .prepare<[number], { kind: string }>("SELECT kind FROM cards WHERE id = ?")
      .get(cardId)?.kind;
    if (kind !== "weather") {
      // The safety guard turned the card into an alert while the photo was read: no odds for it.
      setPhotoState(deps, cardId, photoId, "seen", "odds_kept");
      return;
    }
    if (hasActiveBet(deps, cardId)) {
      // A bet locked the odds the person saw: a late answer does not touch it (AC-006.2).
      setPhotoState(deps, cardId, photoId, "seen", "superseded");
      return;
    }
    if (alert !== null) {
      turnIntoAlert(deps, cardId, alert.reason);
      deps.db.prepare("UPDATE cards SET photo_state = 'seen' WHERE id = ?").run(cardId);
      return;
    }
    const createdAt = deps.now();
    if (settleAt !== ruleRow.settle_at) {
      // The rule band is stored for the final settle window (AC-004.2), as for the first answer.
      const rule = ruleQuoteAt(choreType, hours, anchorMs, settleAt, deps.rules, sunsetMs);
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
      .prepare("UPDATE cards SET photo_state = 'seen', photo_failure = NULL WHERE id = ?")
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
