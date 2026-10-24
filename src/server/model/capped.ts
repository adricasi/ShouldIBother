import { madridDateOf } from "../../domain/time.js";
import type { Db } from "../db.js";

import {
  ModelBusyError,
  ModelCapReachedError,
  ModelDailyLimitError,
  ModelUnavailableError,
  type ChatRequest,
  type ChatResponse,
  type ModelClient,
  type ModelHealth,
} from "./client.js";

/** What the cap writes to the log: counts and job names only, never content or a key (AC-032.5). */
export interface ModelCapLogEntry {
  readonly event: "model-call" | "model-call-refused";
  readonly job: string;
  readonly callsToday: number;
  readonly cap: number;
  /** Why a call was not sent; absent on a call that was. */
  readonly reason?: "daily-limit" | "cap-reached" | "verdicts-first";
}

export interface CappedOptions {
  readonly db: Db;
  readonly now: () => number;
  /** `SIB_DAILY_MODEL_CALLS`. */
  readonly cap: number;
  readonly log?: (entry: ModelCapLogEntry) => void;
  /**
   * How many bets wait for a Gemma verdict and could be tried now (a bet in its retry back-off does
   * not count); they go first after the reset.
   */
  readonly waitingVerdicts?: () => number;
  /** Asks the settlement step to run now, when a call was held back for the waiting verdicts. */
  readonly runWaitingVerdicts?: () => void;
}

/** The job whose calls are the verdicts the last 20 % of the cap is reserved for. */
export const VERDICT_JOB = "judge";
/** The other jobs wait this long at most for the verdicts of a new day to be tried. */
export const VERDICTS_FIRST_MAX_MS = 10 * 60 * 1000;
/**
 * The other jobs stop at this share of the cap. The limit is `floor(cap * 0.8)`: a cap of 10 gives
 * 8 calls to every job and 2 to verdicts, a cap of 7 gives 5 and 2, a cap of 1 gives 0 and 1.
 */
export const OTHER_JOBS_SHARE = 0.8;

interface DayRow {
  calls: number;
  judge_calls: number;
}

/**
 * Hosted mode's spending limit (AC-032.5): at most `cap` chat-completions requests per Madrid day,
 * counted in `model_calls` (migration 0019) so a restart does not reset it. A call is one request;
 * retries and tool rounds count, a health check does not.
 *
 * - Below 80 % of the cap every job may call.
 * - From 80 %, only the judge's verdicts do: the other jobs fail with `ModelDailyLimitError`
 *   without a request, so cards keep rule odds and say "Gemma's daily limit".
 * - At the cap the judge fails too (`ModelUnavailableError`): verdicts wait like Gemma offline
 *   (AC-008.8). A retry is a new call, so it is refused the same way.
 * - After the reset, until a verdict has been tried that day, the other jobs wait
 *   (`ModelBusyError`) while verdicts are waiting, and the settlement step is asked to run.
 */
export class CappedModelClient implements ModelClient {
  private readonly log: (entry: ModelCapLogEntry) => void;
  private readonly softLimit: number;
  /** When the verdicts-first hold began, per Madrid day: it ends after `VERDICTS_FIRST_MAX_MS`. */
  private readonly holdSince = new Map<string, number>();
  /** Refusals are logged once per day and reason, so a busy day does not flood the log. */
  private readonly loggedRefusals = new Set<string>();

  constructor(
    private readonly inner: ModelClient,
    private readonly options: CappedOptions,
  ) {
    this.log = options.log ?? (() => undefined);
    this.softLimit = Math.floor(options.cap * OTHER_JOBS_SHARE);
  }

  private today(): { day: string; row: DayRow } {
    const day = madridDateOf(this.options.now());
    const row = this.options.db
      .prepare<[string], DayRow>("SELECT calls, judge_calls FROM model_calls WHERE day = ?")
      .get(day);
    return { day, row: row ?? { calls: 0, judge_calls: 0 } };
  }

  /** Calls made so far on this Madrid day. */
  callsToday(): number {
    return this.today().row.calls;
  }

  private refuse(
    request: ChatRequest,
    day: string,
    calls: number,
    reason: NonNullable<ModelCapLogEntry["reason"]>,
  ): void {
    const key = `${day}|${reason}`;
    if (!this.loggedRefusals.has(key)) {
      this.loggedRefusals.add(key);
      this.log({
        event: "model-call-refused",
        job: request.job,
        callsToday: calls,
        cap: this.options.cap,
        reason,
      });
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // A request the client would refuse anyway (a photo with vision off) costs nothing: it is not
    // counted, so a bet that can never be sent cannot use up the day's calls.
    const refusal = this.inner.refuses?.(request);
    if (refusal !== undefined) {
      throw new ModelUnavailableError(refusal);
    }
    const { day, row } = this.today();
    const verdict = request.job === VERDICT_JOB;
    const { cap } = this.options;
    if (row.calls >= cap) {
      this.refuse(request, day, row.calls, "cap-reached");
      throw verdict
        ? new ModelCapReachedError(`the daily cap of ${cap} model calls is used up`)
        : new ModelDailyLimitError(`the daily cap of ${cap} model calls is used up`);
    }
    if (!verdict && row.calls >= this.softLimit) {
      this.refuse(request, day, row.calls, "daily-limit");
      throw new ModelDailyLimitError(
        `${this.softLimit} of ${cap} daily model calls are used; the rest is for verdicts`,
      );
    }
    if (!verdict && row.judge_calls === 0 && this.holdForVerdicts(day)) {
      this.refuse(request, day, row.calls, "verdicts-first");
      this.options.runWaitingVerdicts?.();
      throw new ModelBusyError("verdicts that were waiting for Gemma go first");
    }
    this.options.db
      .prepare(
        `INSERT INTO model_calls (day, calls, judge_calls) VALUES (@day, 1, @judge)
         ON CONFLICT (day) DO UPDATE SET calls = calls + 1, judge_calls = judge_calls + @judge`,
      )
      .run({ day, judge: verdict ? 1 : 0 });
    this.log({ event: "model-call", job: request.job, callsToday: row.calls + 1, cap });
    return this.inner.chat(request);
  }

  /**
   * True while a verdict that could be tried now waits and the hold is younger than ten minutes.
   * It ends when none is callable (all done, or all in back-off) or when the ten minutes are up.
   */
  private holdForVerdicts(day: string): boolean {
    if ((this.options.waitingVerdicts?.() ?? 0) === 0) {
      return false;
    }
    const now = this.options.now();
    const since = this.holdSince.get(day) ?? now;
    this.holdSince.set(day, since);
    return now - since < VERDICTS_FIRST_MAX_MS;
  }

  async health(): Promise<ModelHealth> {
    const { row } = this.today();
    if (row.calls >= this.options.cap) {
      return {
        state: "offline",
        detail: `daily cap of ${this.options.cap} model calls reached`,
      };
    }
    return this.inner.health();
  }
}
