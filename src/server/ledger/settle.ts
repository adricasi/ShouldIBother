import { CHORES, isChoreType, type ChoreSpec, type ChoreType } from "../../domain/chores.js";
import { luckyWinOf } from "../../domain/lucky-win.js";
import { ANSWER_WINDOW_MS, GEMMA_RETRY_MS, MAX_QUESTIONS } from "../../domain/settlement.js";
import { MULTIPLIER, pointsFor, type Evidence } from "../../domain/points.js";
import {
  snapshotOf,
  parseWeatherSnapshot,
  type WeatherSnapshot,
} from "../../domain/weather-digest.js";
import { judgeBet, type JudgeEvidence, type JudgeResult } from "../gemma/judge.js";
import { JobQueueFullError } from "../gemma/runner.js";
import { HttpError } from "../problem.js";

import { markDueBets } from "./bets.js";
import type { LedgerDeps } from "./deps.js";
import { addAfterPhoto, checkpointAfterDelete, type PhotoRow } from "./photos.js";
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
  /** Gemma could not judge; the answer is saved and the bet settles when Gemma is back (AC-008.8). */
  | { readonly state: "awaiting_gemma"; readonly failure: string }
  /** The judge asks a yes/no question (AC-008.5). */
  | { readonly state: "question"; readonly question: string };

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
 */
export class Settler {
  private readonly busy = new Set<number>();

  constructor(private readonly deps: LedgerDeps) {}

  /** One tap (AC-008.3). */
  async submitTap(betId: number, answerId: string): Promise<SettleOutcome> {
    const loaded = this.load(betId);
    if (loaded.bet.kind !== "do_nothing") {
      throw new HttpError(409, "Only bets on doing nothing take an answer");
    }
    if (!loaded.chore.tapAnswers.some((answer) => answer.id === answerId)) {
      throw new HttpError(400, "Unknown answer");
    }
    this.assertCanAnswer(loaded.bet);
    this.persistAnswer(loaded, { evidence: "tap", answerId });
    return this.judge(loaded.bet.id, true);
  }

  /** An after photo, with the before photo if the card has one (AC-008.2). */
  async submitPhoto(betId: number, bytes: Buffer): Promise<SettleOutcome> {
    const loaded = this.load(betId);
    if (loaded.bet.kind !== "do_nothing") {
      throw new HttpError(409, "Only bets on doing nothing take an answer");
    }
    this.assertCanAnswer(loaded.bet);
    const photo = await addAfterPhoto(this.deps, loaded.bet.id, bytes);
    try {
      this.persistAnswer(loaded, { evidence: "photo", photo });
    } catch (error) {
      // The answer was not stored: nothing may keep the photo around.
      this.deps.db.prepare("DELETE FROM photos WHERE id = ?").run(photo.id);
      this.deps.photos.remove(photo.file);
      checkpointAfterDelete(this.deps.db);
      throw error;
    }
    return this.judge(loaded.bet.id, true);
  }

  /** The tap on the judge's yes/no question (AC-008.5). */
  answerQuestion(betId: number, yes: boolean): Promise<SettleOutcome> {
    const { bet } = this.load(betId);
    const progress = getProgress(this.deps.db, bet.id);
    if (progress?.question === null || progress === undefined) {
      throw new HttpError(409, "Gemma has no question for this bet");
    }
    this.assertGemmaFree();
    const followups = [...parseFollowups(progress.followups), { question: progress.question, yes }];
    this.deps.db
      .prepare("UPDATE settle_progress SET followups = ?, question = NULL WHERE bet_id = ?")
      .run(JSON.stringify(followups), bet.id);
    return this.judge(bet.id, true);
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
    for (const bet of ready) {
      if (this.busy.has(bet.id) || bet.status === "awaiting_weather") {
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
        }
      } catch (error) {
        if (error instanceof JobQueueFullError) {
          break;
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
    const waitsForPerson =
      bet.kind === "do_nothing" &&
      progress?.evidence == null &&
      now < bet.settle_at + ANSWER_WINDOW_MS;
    const waitsForAnswer = progress?.question != null;
    if (waitsForPerson || waitsForAnswer) {
      if (parseWeatherSnapshot(progress?.weather ?? null) === null) {
        await this.lockedWeather(bet);
      }
      return undefined;
    }
    return this.judge(bet.id, false);
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

  private assertCanAnswer(bet: BetRow): void {
    const progress = getProgress(this.deps.db, bet.id);
    if (progress?.evidence != null) {
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
    if (this.busy.has(bet.id)) {
      throw new HttpError(409, "Gemma is already working on this bet");
    }
    this.assertGemmaFree();
  }

  /** Stores the answer before the judge is called, so an offline Gemma loses nothing (AC-008.8). */
  private persistAnswer(
    loaded: Loaded,
    answer:
      | { readonly evidence: "tap"; readonly answerId: string }
      | { readonly evidence: "photo"; readonly photo: PhotoRow },
  ): void {
    const { db } = this.deps;
    const before = db
      .prepare<[number], { id: string }>(
        `SELECT id FROM photos WHERE card_id = ? AND role = 'before'
         ORDER BY received_at DESC, rowid DESC LIMIT 1`,
      )
      .get(loaded.card.id);
    db.transaction(() => {
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
    })();
  }

  /** Runs the judge on one bet unless another call has it; `user` calls fail loudly when busy. */
  private async judge(betId: number, user: boolean): Promise<SettleOutcome> {
    if (this.busy.has(betId)) {
      if (user) {
        throw new HttpError(409, "Gemma is already working on this bet");
      }
      return { state: "awaiting_gemma", failure: "busy" };
    }
    this.busy.add(betId);
    try {
      return await this.judgeLocked(betId);
    } catch (error) {
      if (user && error instanceof JobQueueFullError) {
        throw gemmaBusy();
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

  private evidenceOf(bet: BetRow, progress: ProgressRow | undefined): JudgeEvidence {
    if (bet.kind === "do_it" || progress?.evidence == null) {
      return { kind: "weather" };
    }
    if (progress.evidence === "tap") {
      return { kind: "tap", answerId: progress.answer_id! };
    }
    const after = this.readPhoto(progress.photo_id);
    const before = this.readPhoto(progress.before_photo_id);
    if (after === undefined) {
      // The photo file is gone (deleted by hand); the answer cannot be judged.
      throw new HttpError(409, "The after photo is no longer there", "Send the answer again.");
    }
    return { kind: "photo", ...(before === undefined ? {} : { before }), after };
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

  private async judgeLocked(betId: number): Promise<SettleOutcome> {
    const { db } = this.deps;
    const { bet, card, choreType, chore } = this.load(betId);
    const progress = getProgress(db, bet.id);
    const snapshot = await this.weatherFor(bet);
    if (snapshot === undefined) {
      return { state: "awaiting_weather" };
    }
    const evidence = this.evidenceOf(bet, progress);
    const followups = parseFollowups(progress?.followups ?? "[]");
    const result: JudgeResult = await judgeBet(this.deps.gemma, {
      chore,
      kind: bet.kind,
      odds: bet.odds,
      evidence,
      weather: snapshot.digest,
      followups,
      canAsk: evidence.kind !== "weather" && followups.length < MAX_QUESTIONS,
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
    const points = pointsFor({
      kind: bet.kind,
      verdict: result.verdict,
      odds: bet.odds,
      evidence: settleEvidence,
    });
    const multiplier = bet.kind === "do_it" ? 1 : MULTIPLIER[settleEvidence];
    const lucky =
      bet.kind === "do_nothing" && result.verdict === "win"
        ? luckyWinOf(
            choreType,
            { placedAt: bet.placed_at, settleAt: bet.settle_at },
            snapshot.hours,
          )
        : null;
    const settledAt = this.deps.now();
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
            `INSERT INTO settlements (bet_id, evidence, multiplier, verdict, lucky_win, weather,
               decision_id, points, settled_at, appeal_of, final)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
          )
          .run(
            bet.id,
            settleEvidence,
            multiplier,
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
