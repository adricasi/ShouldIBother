import { betChoreSpec, isChoreType, type ChoreType } from "../../domain/chores.js";
import { MULTIPLIER, pointsFor, type Verdict } from "../../domain/points.js";
import { parseWeatherSnapshot } from "../../domain/weather-digest.js";
import { judgeBet, type JudgeEvidence } from "../gemma/judge.js";
import { JobQueueFullError } from "../gemma/runner.js";
import { HttpError } from "../problem.js";

import { unlockAfterCommit } from "./achievements.js";
import { appealPaysHalf, appealRefusal, originalSettlement } from "./appeal-state.js";
import type { LedgerDeps } from "./deps.js";
import { luckyFlagFor } from "./lucky-flag.js";
import { addAfterPhoto, deletePhoto, type PhotoRow } from "./photos.js";
import { readOf, receiptOf, type Receipt } from "./receipt.js";
import type { BetRow, CardRow, SettlementRow } from "./rows.js";
import { gemmaBusy } from "./settle.js";
import { getProgress } from "./settle-progress.js";

interface Appealable {
  readonly bet: BetRow;
  readonly card: CardRow;
  readonly choreType: ChoreType;
  readonly original: SettlementRow;
}

/**
 * Appeals (REQ-023). The person sends one new photo for a settled bet on doing nothing; the judge
 * looks again (the same job, with the appeal prompt), and its second verdict replaces the first:
 * the first settlement row stops being final, the appeal row is final, and both stay in the
 * database, the export and the receipt.
 *
 * - One appeal per bet (AC-023.2): refused with 409 once an appeal row exists; the database
 *   enforces it too (migration 0012).
 * - The points are those of the new verdict at the photo multiplier (AC-023.1). A verdict
 *   committed 24 h or more after the settle time pays a win at x0.5 whatever the evidence
 *   (AC-008.8), and an appeal is such a verdict whenever it comes that late; the row is flagged
 *   `multiplier_capped` as for any late settlement.
 * - Nothing is changed unless the judge answers: a busy or offline Gemma, a timeout or an invalid
 *   answer leaves the bet as it was, the new photo is deleted, and the person can appeal again.
 *   The first verdict stands meanwhile; no bet waits in `awaiting_gemma` for an appeal.
 * - The weather is the snapshot of the first settlement: the recorded window did not change.
 */
export class Appealer {
  private readonly busy = new Set<number>();

  /** `makeReceipt` is the receipt builder; a test passes one that fails to prove the cleanup rules. */
  constructor(
    private readonly deps: LedgerDeps,
    private readonly makeReceipt: typeof receiptOf = receiptOf,
  ) {}

  /**
   * Every refusal that needs no upload, so a refused request is not buffered first: unknown bet
   * (404), nothing to appeal or already appealed (409), Gemma's queue full (503).
   */
  check(betId: number): void {
    this.target(betId);
    if (this.busy.has(betId)) {
      throw new HttpError(409, "An appeal is already being decided for this bet");
    }
    if (this.deps.gemma.full) {
      throw gemmaBusy();
    }
  }

  async appeal(betId: number, bytes: Buffer): Promise<Receipt> {
    this.check(betId);
    this.busy.add(betId);
    let photo: PhotoRow | undefined;
    let decided: { readonly target: Appealable; readonly settlement: SettlementRow };
    try {
      photo = await addAfterPhoto(
        this.deps,
        betId,
        bytes,
        () => {
          // Repeated inside the transaction that stores the photo: decoding it took time.
          this.target(betId);
        },
        "appeal",
      );
      decided = await this.decide(this.target(betId), photo);
    } catch (error) {
      // The first verdict stands: nothing keeps the new photo, so it is not left behind. This
      // runs only while no appeal was committed; once it is, the photo and the decision belong to
      // it and are never deleted here. A cleanup that fails (the bet or photo was deleted
      // meanwhile) is logged and never replaces the error the person needs to see.
      if (photo !== undefined) {
        this.discard(photo);
      }
      throw error;
    } finally {
      this.busy.delete(betId);
    }
    // Outside the try that owns the cleanup: a failure here cannot delete a committed appeal's data.
    const { target, settlement } = decided;
    return this.makeReceipt(
      this.deps,
      target.bet,
      target.card,
      settlement,
      getProgress(this.deps.db, betId),
    );
  }

  private discard(photo: PhotoRow): void {
    try {
      deletePhoto(this.deps, photo.id);
    } catch (error) {
      this.deps.log({
        event: "appeal-photo-cleanup-failed",
        bet_id: photo.bet_id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private target(betId: number): Appealable {
    const { db } = this.deps;
    const bet = db.prepare<[number], BetRow>("SELECT * FROM bets WHERE id = ?").get(betId);
    if (bet === undefined) {
      throw new HttpError(404, "Bet not found");
    }
    const refusal = appealRefusal(db, bet);
    if (refusal !== undefined) {
      throw refusal;
    }
    const original = originalSettlement(db, betId);
    const card = db.prepare<[number], CardRow>("SELECT * FROM cards WHERE id = ?").get(bet.card_id);
    if (
      original === undefined ||
      card === undefined ||
      betChoreSpec(card.chore_type) === undefined
    ) {
      throw new HttpError(409, "This bet cannot be appealed");
    }
    const choreType = isChoreType(card.chore_type) ? card.chore_type : "laundry_line";
    return { bet, card, choreType, original };
  }

  private readPhoto(file: string): Buffer | undefined {
    try {
      return this.deps.photos.read(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async decide(
    target: Appealable,
    photo: PhotoRow,
  ): Promise<{ readonly target: Appealable; readonly settlement: SettlementRow }> {
    const { db } = this.deps;
    const { bet, card, choreType, original } = target;
    const chore = betChoreSpec(card.chore_type)!;
    const after = this.readPhoto(photo.file);
    if (after === undefined) {
      throw new HttpError(409, "The new photo is no longer there", "Please send it again.");
    }
    const beforeRow = db
      .prepare<[number], { file: string }>(
        `SELECT file FROM photos WHERE card_id = ? AND role = 'before'
         ORDER BY received_at DESC, rowid DESC LIMIT 1`,
      )
      .get(card.id);
    const before = beforeRow === undefined ? undefined : this.readPhoto(beforeRow.file);
    const evidence: JudgeEvidence = {
      kind: "photo",
      ...(before === undefined ? {} : { before }),
      after,
    };
    const snapshot = parseWeatherSnapshot(original.weather);
    let result;
    try {
      result = await judgeBet(this.deps.gemma, {
        chore,
        kind: "do_nothing",
        odds: bet.odds,
        evidence,
        weather: snapshot?.digest ?? null,
        followups: [],
        canAsk: false,
        betId: bet.id,
        cardId: card.id,
        photoId: photo.id,
        appeal: {
          firstVerdict: original.verdict as Verdict,
          firstReason: readOf(this.deps, original.decision_id)?.reason ?? null,
          firstEvidence: original.evidence === "auto" ? "weather" : original.evidence,
        },
      });
    } catch (error) {
      if (error instanceof JobQueueFullError) {
        throw gemmaBusy();
      }
      throw error;
    }
    if (!result.ok) {
      // The failed attempt's decision row is deleted with the new photo (AC-015.2: a photo's
      // decisions go with it), so the attempt is kept in the app log instead: ids and the failure
      // code only, never content.
      this.deps.log({
        event: "appeal-judge-failed",
        bet_id: bet.id,
        decision_id: result.decisionId,
        failure: result.failure,
      });
      throw new HttpError(
        503,
        "Gemma could not look again",
        "Nothing was changed. Try the appeal again in a minute.",
      );
    }

    const settledAt = this.deps.now();
    const capped = appealPaysHalf(bet, settledAt) && MULTIPLIER.photo > MULTIPLIER.auto;
    const evidenceUsed = capped ? "auto" : "photo";
    const points = pointsFor({
      kind: "do_nothing",
      verdict: result.verdict,
      odds: bet.odds,
      evidence: evidenceUsed,
    });
    const lucky =
      result.verdict === "win" && snapshot !== null
        ? await luckyFlagFor(this.deps, choreType, bet, card, snapshot)
        : null;
    const commit = db.transaction((): SettlementRow => {
      const settled = db
        .prepare("SELECT 1 FROM bets WHERE id = ? AND status = 'settled'")
        .get(bet.id);
      // The first row stops being final before the second is inserted: one final row per bet.
      const flipped = db
        .prepare(
          "UPDATE settlements SET final = 0 WHERE id = ? AND final = 1 AND appeal_of IS NULL",
        )
        .run(original.id).changes;
      if (settled === undefined || flipped !== 1) {
        throw new HttpError(409, "This bet cannot be appealed");
      }
      let id: number;
      try {
        id = Number(
          db
            .prepare(
              `INSERT INTO settlements (bet_id, evidence, multiplier, multiplier_capped, verdict,
                 lucky_win, weather, decision_id, points, settled_at, appeal_of, final)
               VALUES (?, 'photo', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            )
            .run(
              bet.id,
              MULTIPLIER[evidenceUsed],
              capped ? 1 : 0,
              result.verdict,
              lucky === null ? null : lucky ? 1 : 0,
              original.weather,
              result.decisionId,
              points,
              settledAt,
              original.id,
            ).lastInsertRowid,
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "SQLITE_CONSTRAINT_UNIQUE") {
          // A second appeal got in first (migration 0012's unique index).
          throw new HttpError(409, "This bet was already appealed");
        }
        // The trigger's ABORT or any other constraint is a bug, not a refusal: it surfaces as a
        // 500 and leaves a line in the log (ids and the code only).
        this.deps.log({ event: "appeal-constraint-violation", bet_id: bet.id, code });
        throw error;
      }
      return db.prepare<[number], SettlementRow>("SELECT * FROM settlements WHERE id = ?").get(id)!;
    });
    const settlement = commit.immediate();
    unlockAfterCommit(this.deps);
    return { target, settlement };
  }
}
