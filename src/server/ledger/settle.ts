import { CHORES, isChoreType, type ChoreSpec, type ChoreType } from "../../domain/chores.js";
import {
  MissingSunsetError,
  cutWindowOf,
  labelWindowOf,
  luckyWinOf,
} from "../../domain/lucky-win.js";
import { ANSWER_WINDOW_MS, GEMMA_RETRY_MS, MAX_QUESTIONS } from "../../domain/settlement.js";
import { MULTIPLIER, pointsFor, type Evidence } from "../../domain/points.js";
import {
  snapshotOf,
  parseWeatherSnapshot,
  type WeatherSnapshot,
} from "../../domain/weather-digest.js";
import {
  CANNOT_ASK_MESSAGE,
  judgeBet,
  type JudgeEvidence,
  type JudgeResult,
} from "../gemma/judge.js";
import { JobQueueFullError } from "../gemma/runner.js";
import { HttpError } from "../problem.js";
import { WeatherUnavailableError } from "../weather/client.js";

import { markDueBets } from "./bets.js";
import type { LedgerDeps } from "./deps.js";
import { addAfterPhoto, type PhotoRow } from "./photos.js";
import { receiptOf, type Receipt } from "./receipt.js";
import { collectRecordedWeather } from "./recorded-weather.js";
import type { BetRow, CardRow, ProgressRow, SettlementRow } from "./rows.js";
import { ensureProgress, getProgress, parseFollowups } from "./settle-progress.js";

export { pointsTotal } from "./points.js";

/** Statuses from which a bet whose settle time has come is being settled. */
const READY_STATUSES = ["due", "awaiting_weather", "awaiting_gemma"] as const;

export type SettleOutcome =
  | { readonly state: "settled"; readonly receipt: Receipt }
  /** The recorded weather is not there yet; the answer is saved (AC-014.5). */
  | { readonly state: "awaiting_weather" }
  /**
   * Gemma could not judge (or is busy); the answer is saved and the bet settles when Gemma is
   * back (AC-008.8).
   */
  | { readonly state: "awaiting_gemma"; readonly failure: string }
  /** The judge asks a yes/no question (AC-008.5). */
  | { readonly state: "question"; readonly question: string }
  /** The saved after photo was gone: the answer was dropped and can be given again. */
  | { readonly state: "answer_needed" };

export function gemmaBusy(): HttpError {
  return new HttpError(503, "Gemma is busy", "Nothing was changed; try again in a minute.");
}

interface Loaded {
  readonly bet: BetRow;
  readonly card: CardRow;
  readonly choreType: ChoreType;
  readonly chore: ChoreSpec;
}

/**
 * Settlement (REQ-008, REQ-009): the person's answer is stored first, then the Gemma judge gives
 * the verdict, and code turns it into points. The rule never settles a bet: when the judge is
 * offline, times out or answers badly, the bet waits in `awaiting_gemma` with the answer kept and
 * the scheduler tries again (AC-008.8). One bet is judged at a time, so a tap and the scheduler
 * cannot settle the same bet twice.
 *
 * Every refusal (409, 503) happens before the answer is written. Once it is written the person
 * never gets an error: a busy Gemma becomes `awaiting_gemma` and the scheduler finishes the job.
 *
 * A settlement committed at or after settle time + 24 h pays a win at x0.5 whatever the evidence
 * (AC-008.8); the stored evidence stays, and `multiplier_capped` marks the row.
 *
 * A do-it decision is stored with evidence `auto` and multiplier 1: nobody answered, and no
 * multiplier applies to its fixed points. Anything that reads `evidence = 'auto'` must filter on
 * the bet's kind (an `auto` do-it is not an unanswered bet).
 */
export class Settler {
  private readonly busy = new Set<number>();

  constructor(private readonly deps: LedgerDeps) {}

  /** One tap (AC-008.3). */
  submitTap(betId: number, answerId: string): Promise<SettleOutcome> {
    const loaded = this.load(betId);
    if (loaded.bet.kind !== "do_nothing") {
      throw new HttpError(409, "Only bets on doing nothing take an answer");
    }
    if (!loaded.chore.tapAnswers.some((answer) => answer.id === answerId)) {
      throw new HttpError(400, "Unknown answer");
    }
    this.assertCanAnswer(loaded.bet);
    this.deps.db
      .transaction(() => {
        this.writeAnswer(loaded, { evidence: "tap", answerId });
      })
      .immediate();
    return this.judge(loaded.bet.id);
  }

  /**
   * The checks of an after photo that need no upload, so a refused request is not buffered first
   * (the route calls this before it reads the body).
   */
  checkPhotoAnswer(betId: number): void {
    const loaded = this.load(betId);
    if (loaded.bet.kind !== "do_nothing") {
      throw new HttpError(409, "Only bets on doing nothing take an answer");
    }
    this.assertCanAnswer(loaded.bet);
  }

  /** An after photo, with the before photo if the card has one (AC-008.2). */
  async submitPhoto(betId: number, bytes: Buffer): Promise<SettleOutcome> {
    this.checkPhotoAnswer(betId);
    const loaded = this.load(betId);
    // The photo row and the answer are stored in one transaction (see `addAfterPhoto`); the
    // checks are repeated inside it, because decoding the photo takes time.
    await addAfterPhoto(this.deps, loaded.bet.id, bytes, (photo) => {
      this.writeAnswer(loaded, { evidence: "photo", photo });
    });
    return this.judge(loaded.bet.id);
  }

  /** The tap on the judge's yes/no question (AC-008.5). */
  answerQuestion(betId: number, yes: boolean): Promise<SettleOutcome> {
    const { bet } = this.load(betId);
    if (this.busy.has(bet.id)) {
      throw new HttpError(409, "Gemma is already working on this bet");
    }
    // Right before the question is cleared: after this nothing is refused.
    this.assertGemmaFree();
    this.deps.db
      .transaction(() => {
        const progress = getProgress(this.deps.db, bet.id);
        if (progress?.question == null) {
          throw new HttpError(409, "Gemma has no question for this bet");
        }
        const followups = [
          ...parseFollowups(progress.followups),
          { question: progress.question, yes },
        ];
        this.deps.db
          .prepare("UPDATE settle_progress SET followups = ?, question = NULL WHERE bet_id = ?")
          .run(JSON.stringify(followups), bet.id);
      })
      .immediate();
    return this.judge(bet.id);
  }

  /**
   * One scheduler pass over the bets whose settle time has come: stores the recorded weather for
   * the settle screen, judges do-it decisions (AC-008.9), answered bets that wait for Gemma
   * (AC-008.8) and bets without an answer 24 h after their settle time (AC-008.7). Returns how
   * many bets it settled.
   */
  async runPass(): Promise<number> {
    const { db } = this.deps;
    const now = this.deps.now();
    markDueBets(db, now);
    const ready = db
      .prepare<[number], BetRow>(
        `SELECT * FROM bets WHERE status IN ('due', 'awaiting_weather', 'awaiting_gemma')
         AND settle_at <= ? ORDER BY settle_at, id`,
      )
      .all(now);
    let settled = 0;
    for (const listed of ready) {
      // Another call may have settled or changed the bet since the list was read.
      const bet = db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(listed.id);
      if (
        bet === undefined ||
        !(READY_STATUSES as readonly string[]).includes(bet.status) ||
        this.busy.has(bet.id) ||
        bet.status === "awaiting_weather"
      ) {
        // The weather step (every 30 min) releases an awaiting_weather bet.
        continue;
      }
      const progress = getProgress(db, bet.id);
      if (
        progress?.failure != null &&
        progress.tried_at !== null &&
        now - progress.tried_at < GEMMA_RETRY_MS
      ) {
        continue;
      }
      try {
        const outcome = await this.passFor(bet, progress, now);
        if (outcome?.state === "settled") {
          settled += 1;
        } else if (outcome?.state === "awaiting_gemma" && this.deps.gemma.full) {
          break;
        }
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          // Settled or changed by someone else in the meantime: nothing to do.
          continue;
        }
        this.deps.log({ event: "settle-pass-error", bet_id: bet.id, error: String(error) });
      }
    }
    return settled;
  }

  /** What the pass does with one bet; undefined when it waits for the person. */
  private async passFor(
    bet: BetRow,
    progress: ProgressRow | undefined,
    now: number,
  ): Promise<SettleOutcome | undefined> {
    const inTime = now < bet.settle_at + ANSWER_WINDOW_MS;
    const waitsForPerson = bet.kind === "do_nothing" && progress?.evidence == null && inTime;
    // An open question blocks nothing for ever: after 24 h the judge has to decide (C1).
    const waitsForAnswer = progress?.question != null && inTime;
    if (waitsForPerson || waitsForAnswer) {
      if (parseWeatherSnapshot(progress?.weather ?? null) === null) {
        await this.lockedWeather(bet);
      }
      return undefined;
    }
    return this.judge(bet.id);
  }

  private async lockedWeather(bet: BetRow): Promise<void> {
    if (this.busy.has(bet.id)) {
      return;
    }
    this.busy.add(bet.id);
    try {
      await this.weatherFor(bet);
    } finally {
      this.busy.delete(bet.id);
    }
  }

  private load(betId: number): Loaded {
    const { db } = this.deps;
    // A tap right after the settle time must not wait for the next scheduler pass.
    markDueBets(db, this.deps.now());
    const bet = db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(betId);
    if (bet === undefined) {
      throw new HttpError(404, "Bet not found");
    }
    if (!(READY_STATUSES as readonly string[]).includes(bet.status)) {
      throw new HttpError(
        409,
        bet.status === "open"
          ? "This bet is not ready to settle yet"
          : "This bet cannot be settled",
      );
    }
    const card = db
      .prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?")
      .get(bet.card_id)!;
    if (!isChoreType(card.chore_type)) {
      throw new HttpError(409, "This chore cannot be settled yet");
    }
    return { bet, card, choreType: card.chore_type, chore: CHORES[card.chore_type] };
  }

  private assertGemmaFree(): void {
    // Before any state changes: a full queue means nothing is stored (the person tries again).
    if (this.deps.gemma.full) {
      throw gemmaBusy();
    }
  }

  /**
   * Whether an answer can be written now, from the stored bet (so it also holds inside the
   * transaction that writes it, after a photo took time to decode).
   */
  private assertAnswerable(betId: number): void {
    const { db } = this.deps;
    const bet = db
      .prepare<[number], Pick<BetRow, "status" | "kind" | "settle_at">>(
        "SELECT status, kind, settle_at FROM bets WHERE id = ?",
      )
      .get(betId);
    if (bet === undefined || !(READY_STATUSES as readonly string[]).includes(bet.status)) {
      throw new HttpError(409, "This bet cannot be settled");
    }
    if (bet.kind !== "do_nothing") {
      throw new HttpError(409, "Only bets on doing nothing take an answer");
    }
    if (getProgress(db, betId)?.evidence != null) {
      throw new HttpError(
        409,
        "Your answer is already saved",
        "Gemma settles this bet as soon as it can.",
      );
    }
    if (this.deps.now() >= bet.settle_at + ANSWER_WINDOW_MS) {
      throw new HttpError(
        409,
        "Too late for an answer",
        "After 24 hours Gemma settles a bet from the weather record at half points.",
      );
    }
    if (this.busy.has(betId)) {
      throw new HttpError(409, "Gemma is already working on this bet");
    }
  }

  private assertCanAnswer(bet: BetRow): void {
    this.assertAnswerable(bet.id);
    this.assertGemmaFree();
  }

  /**
   * Stores the answer before the judge is called, so an offline Gemma loses nothing (AC-008.8).
   * Runs inside the caller's transaction, and repeats the checks that a slow upload may have
   * changed: the status, the 24 h limit, an answer already saved, a call in progress.
   */
  private writeAnswer(
    loaded: Loaded,
    answer:
      | { readonly evidence: "tap"; readonly answerId: string }
      | { readonly evidence: "photo"; readonly photo: PhotoRow },
  ): void {
    const { db } = this.deps;
    this.assertAnswerable(loaded.bet.id);
    const before = db
      .prepare<[number], { id: string }>(
        `SELECT id FROM photos WHERE card_id = ? AND role = 'before'
         ORDER BY received_at DESC, rowid DESC LIMIT 1`,
      )
      .get(loaded.card.id);
    ensureProgress(db, loaded.bet.id);
    const stored = db
      .prepare(
        `UPDATE settle_progress SET evidence = ?, answer_id = ?, photo_id = ?, before_photo_id = ?,
           answered_at = ?, question = NULL, followups = '[]', failure = NULL
         WHERE bet_id = ? AND evidence IS NULL`,
      )
      .run(
        answer.evidence,
        answer.evidence === "tap" ? answer.answerId : null,
        answer.evidence === "photo" ? answer.photo.id : null,
        answer.evidence === "photo" ? (before?.id ?? null) : null,
        this.deps.now(),
        loaded.bet.id,
      ).changes;
    if (stored !== 1) {
      throw new HttpError(409, "Your answer is already saved");
    }
  }

  /**
   * Runs the judge on one bet unless another call has it. It never throws for a busy Gemma: the
   * answer is stored by now, so the bet waits in `awaiting_gemma` and the scheduler finishes it.
   */
  private async judge(betId: number): Promise<SettleOutcome> {
    if (this.busy.has(betId)) {
      return { state: "awaiting_gemma", failure: "busy" };
    }
    this.busy.add(betId);
    try {
      return await this.judgeLocked(betId);
    } catch (error) {
      if (error instanceof JobQueueFullError) {
        return { state: "awaiting_gemma", failure: "busy" };
      }
      throw error;
    } finally {
      this.busy.delete(betId);
    }
  }

  /** The recorded weather of the bet's window, from the stored snapshot or a fetch (AC-008.1). */
  private async weatherFor(bet: BetRow): Promise<WeatherSnapshot | undefined> {
    const { db } = this.deps;
    const stored = parseWeatherSnapshot(getProgress(db, bet.id)?.weather ?? null);
    if (stored !== null) {
      return stored;
    }
    const recorded = await collectRecordedWeather(this.deps, bet);
    ensureProgress(db, bet.id);
    if (recorded === undefined) {
      db.prepare(
        "UPDATE settle_progress SET failure = 'weather', tried_at = ? WHERE bet_id = ?",
      ).run(this.deps.now(), bet.id);
      return undefined;
    }
    const snapshot = snapshotOf({
      fetchedAt: recorded.fetchedAt,
      fromMs: bet.placed_at,
      toMs: bet.settle_at,
      hours: recorded.hours,
    });
    db.prepare(
      `UPDATE settle_progress
       SET weather = ?, failure = CASE WHEN failure = 'weather' THEN NULL ELSE failure END
       WHERE bet_id = ? AND weather IS NULL`,
    ).run(JSON.stringify(snapshot), bet.id);
    return snapshot;
  }

  /** How the outcome is known; undefined when the saved after photo is gone from the disk. */
  private evidenceOf(bet: BetRow, progress: ProgressRow | undefined): JudgeEvidence | undefined {
    if (bet.kind === "do_it" || progress?.evidence == null) {
      return { kind: "weather" };
    }
    if (progress.evidence === "tap") {
      return { kind: "tap", answerId: progress.answer_id! };
    }
    const after = this.readPhoto(progress.photo_id);
    if (after === undefined) {
      return undefined;
    }
    const before = this.readPhoto(progress.before_photo_id);
    return { kind: "photo", ...(before === undefined ? {} : { before }), after };
  }

  /**
   * The after photo file is gone (removed by hand): drop its row, and with it (migration 0007
   * cascade) the saved answer, so the bet is back to "answer needed" or, past 24 h, to the
   * weather record. Logged with the bet id only.
   */
  private dropMissingPhoto(betId: number, photoId: string | null): void {
    if (photoId !== null) {
      this.deps.db.prepare("DELETE FROM photos WHERE id = ?").run(photoId);
    }
    this.deps.log({ event: "settle-photo-missing", bet_id: betId });
  }

  private readPhoto(id: string | null): Buffer | undefined {
    if (id === null) {
      return undefined;
    }
    const row = this.deps.db
      .prepare<[string], { file: string }>("SELECT file FROM photos WHERE id = ?")
      .get(id);
    if (row === undefined) {
      return undefined;
    }
    try {
      return this.deps.photos.read(row.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * The lucky flag of a won bet (AC-008.6): the chore's outcome label on its full fixed window,
   * with the hours before the bet was placed read from the recorded weather too. Where those
   * cannot be fetched, the label is applied to the window the settle snapshot covers. Laundry
   * tonight's window starts at the sunset stored on its card; without one the flag is unknown.
   */
  private async luckyFor(
    choreType: ChoreType,
    bet: BetRow,
    card: CardRow,
    snapshot: WeatherSnapshot,
  ): Promise<boolean | null> {
    const times = {
      placedAt: bet.placed_at,
      settleAt: bet.settle_at,
      sunsetAt: card.sunset_at,
    };
    let window;
    try {
      window = labelWindowOf(choreType, times, this.deps.now());
    } catch (error) {
      if (error instanceof MissingSunsetError) {
        return null;
      }
      throw error;
    }
    if (window.endMs > window.startMs) {
      try {
        const recorded = await this.deps.weather.getRecorded({
          fromMs: window.startMs,
          toMs: window.endMs,
        });
        if (recorded.complete) {
          return luckyWinOf(choreType, window, recorded.hours);
        }
      } catch (error) {
        if (!(error instanceof WeatherUnavailableError)) {
          throw error;
        }
      }
    }
    return luckyWinOf(choreType, cutWindowOf(choreType, times), snapshot.hours);
  }

  private async judgeLocked(betId: number): Promise<SettleOutcome> {
    const { db } = this.deps;
    const { bet, card, choreType, chore } = this.load(betId);
    let progress = getProgress(db, bet.id);
    const snapshot = await this.weatherFor(bet);
    if (snapshot === undefined) {
      return { state: "awaiting_weather" };
    }
    const pastWindow = this.deps.now() >= bet.settle_at + ANSWER_WINDOW_MS;
    let evidence = this.evidenceOf(bet, progress);
    if (evidence === undefined) {
      this.dropMissingPhoto(bet.id, progress?.photo_id ?? null);
      progress = getProgress(db, bet.id);
      if (!pastWindow) {
        return { state: "answer_needed" };
      }
      evidence = { kind: "weather" };
    }
    if (pastWindow && progress?.question != null) {
      // An open question does not hold a bet back for ever: after 24 h the judge decides.
      db.prepare("UPDATE settle_progress SET question = NULL WHERE bet_id = ?").run(bet.id);
    }
    const followups = parseFollowups(progress?.followups ?? "[]");
    const canAsk = evidence.kind !== "weather" && followups.length < MAX_QUESTIONS && !pastWindow;
    const result: JudgeResult = await judgeBet(this.deps.gemma, {
      chore,
      kind: bet.kind,
      odds: bet.odds,
      evidence,
      weather: snapshot.digest,
      followups,
      canAsk,
      betId: bet.id,
      cardId: bet.card_id,
      ...(progress?.evidence === "photo" && progress.photo_id !== null
        ? { photoId: progress.photo_id }
        : {}),
    });
    ensureProgress(db, bet.id);
    if (!result.ok) {
      if (result.failure === "unsure" && result.question !== undefined) {
        db.prepare(
          "UPDATE settle_progress SET question = ?, failure = NULL, tried_at = ? WHERE bet_id = ?",
        ).run(result.question, this.deps.now(), bet.id);
        return { state: "question", question: result.question };
      }
      if (
        !canAsk &&
        evidence.kind !== "weather" &&
        result.failure === "invalid" &&
        result.error.includes(CANNOT_ASK_MESSAGE)
      ) {
        // The judge was unsure again after the questions were used up: noted, without content.
        this.deps.log({ event: "settle-judge-unsure-after-cap", bet_id: bet.id });
      }
      // Offline, timed out, invalid, internal: the bet waits for Gemma; the rule never settles it.
      db.prepare(
        "UPDATE bets SET status = 'awaiting_gemma' WHERE id = ? AND status IN ('due', 'awaiting_weather')",
      ).run(bet.id);
      db.prepare("UPDATE settle_progress SET failure = ?, tried_at = ? WHERE bet_id = ?").run(
        result.failure,
        this.deps.now(),
        bet.id,
      );
      return { state: "awaiting_gemma", failure: result.failure };
    }

    const settleEvidence: Evidence =
      bet.kind === "do_it" || evidence.kind === "weather" ? "auto" : evidence.kind;
    // AC-008.8: a verdict committed 24 h or more after the settle time pays a win at x0.5,
    // whatever the evidence; the row keeps the evidence and marks the cap.
    const settledAt = this.deps.now();
    const capped =
      bet.kind === "do_nothing" &&
      settledAt >= bet.settle_at + ANSWER_WINDOW_MS &&
      MULTIPLIER[settleEvidence] > MULTIPLIER.auto;
    const points = pointsFor({
      kind: bet.kind,
      verdict: result.verdict,
      odds: bet.odds,
      evidence: capped ? "auto" : settleEvidence,
    });
    const multiplier = bet.kind === "do_it" ? 1 : MULTIPLIER[capped ? "auto" : settleEvidence];
    const lucky =
      bet.kind === "do_nothing" && result.verdict === "win"
        ? await this.luckyFor(choreType, bet, card, snapshot)
        : null;
    const commit = db.transaction((): SettlementRow => {
      // The status guard makes a second settlement of the same bet fail instead of paying twice.
      const moved = db
        .prepare(
          `UPDATE bets SET status = 'settled'
           WHERE id = ? AND status IN ('due', 'awaiting_weather', 'awaiting_gemma')`,
        )
        .run(bet.id).changes;
      if (moved !== 1) {
        throw new HttpError(409, "This bet cannot be settled");
      }
      const id = Number(
        db
          .prepare(
            `INSERT INTO settlements (bet_id, evidence, multiplier, multiplier_capped, verdict,
               lucky_win, weather, decision_id, points, settled_at, appeal_of, final)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
          )
          .run(
            bet.id,
            settleEvidence,
            multiplier,
            capped ? 1 : 0,
            result.verdict,
            lucky === null ? null : lucky ? 1 : 0,
            JSON.stringify(snapshot),
            result.decisionId,
            points,
            settledAt,
          ).lastInsertRowid,
      );
      db.prepare("UPDATE settle_progress SET question = NULL, failure = NULL WHERE bet_id = ?").run(
        bet.id,
      );
      return db.prepare<[number], SettlementRow>("SELECT * FROM settlements WHERE id = ?").get(id)!;
    });
    const settlement = commit();
    return {
      state: "settled",
      receipt: receiptOf(
        this.deps,
        { ...bet, status: "settled" },
        card,
        settlement,
        getProgress(db, bet.id),
      ),
    };
  }
}
