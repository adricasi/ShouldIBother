import { CHORES, LAUNDRY_PLAN, LAUNDRY_PLAN_SPEC, type ChoreType } from "../domain/chores.js";
import { PLAN_FORECAST_HOURS, planDayFacts } from "../domain/laundry-plan.js";
import type { RulesConfig } from "../domain/rules/index.js";
import { madridDateOf, madridWallTimeToEpochMs } from "../domain/time.js";
import { digestOf } from "../domain/weather-digest.js";
import { hoursInWindow } from "../domain/weather.js";
import type { Db } from "../server/db.js";
import { BOOKMAKER_PROMPT, runBookmaker, type BookmakerInput } from "../server/gemma/bookmaker.js";
import { INSPECTOR_PROMPT, runInspector } from "../server/gemma/inspector.js";
import { JUDGE_PROMPT, judgeBet, type JudgeEvidence } from "../server/gemma/judge.js";
import {
  LAUNDRY_PLANNER_PROMPT,
  runLaundryPlanner,
  type LaundryPlannerInput,
} from "../server/gemma/laundry-planner.js";
import { LISTENER_PROMPT, runListener } from "../server/gemma/listener.js";
import type { JobFailure, JobResult, JobRunner } from "../server/gemma/runner.js";
import { SAFETY_PROMPT, runSafetyGuard } from "../server/gemma/safety.js";
import { ruleBandOrFallback, ruleQuoteAt, ruleWindowAt } from "../server/ledger/chore-rules.js";
import { FORECAST_HOURS, FORECAST_PAST_HOURS, forecastFrom } from "../server/ledger/forecast.js";

import type { CallLog, LoggedCall } from "./call-log.js";
import {
  bookmakerCaseSchema,
  inspectorCaseSchema,
  judgeCaseSchema,
  listenerCaseSchema,
  plannerCaseSchema,
  readCaseFile,
  safetyCaseSchema,
  type BookmakerCase,
  type EvalJob,
  type InspectorCase,
  type JudgeCase,
  type ListenerCase,
  type PlannerCase,
  type SafetyCase,
} from "./cases.js";
import { MAX_OUTPUT_CHARS, type CaseRecord, type CaseRun, type StepRecord } from "./types.js";
import { syntheticForecast, syntheticRecorded } from "./weather.js";

/** What a case needs while it runs. */
export interface EvalContext {
  readonly runner: JobRunner;
  readonly log: CallLog;
  readonly db: Db;
  readonly rules: RulesConfig;
  /** A processed staged photo (the app's own pipeline: at most 1024 px, no metadata). */
  readonly photo: (name: string) => { data: Uint8Array; width: number; height: number };
  /** A card number for the decision log; the eval has no cards. */
  readonly nextCardId: () => number;
}

/** A case ready to run: the job's own function is called on it, exactly as the live app does. */
export interface PreparedCase {
  readonly id: string;
  readonly note: string | null;
  readonly expect: readonly string[] | undefined;
  /** Staged photos the case needs from the `--photos` folder. */
  readonly photos: readonly { readonly name: string; readonly staging: string }[];
  run(context: EvalContext): Promise<CaseRun>;
}

export interface EvalJobSpec {
  readonly job: EvalJob;
  /** The step that is "the job" for the valid-JSON target (the inspector case also runs the bookmaker). */
  readonly primaryStep: string;
  /** The photo judgement budget of NFR-004 applies to the whole case. */
  readonly photoBudget: boolean;
  /** Prompt versions the job uses, for the report. */
  readonly promptVersions: readonly string[];
  prepare(casesPath: string): PreparedCase[];
}

const parseNow = (now: string): number =>
  madridWallTimeToEpochMs(now.slice(0, 10), now.slice(11, 16));

function cut(text: string | undefined): string | null {
  return text === undefined ? null : text.slice(0, MAX_OUTPUT_CHARS);
}

/** `unsure` when Gemma asked a question; the listener has no such path and is always `ok`. */
function statusOf(output: unknown): "ok" | "unsure" {
  return (output as { status?: unknown }).status === "unsure" ? "unsure" : "ok";
}

/** The step record of a finished runner job. */
function stepOfJob<T>(job: string, result: JobResult<T>, calls: readonly LoggedCall[]): StepRecord {
  const first = calls[0];
  return {
    job,
    valid: result.ok,
    failure: result.ok ? null : result.failure,
    status: result.ok ? statusOf(result.output) : null,
    toolMode: result.toolMode ?? null,
    firstAnswerHadToolCall:
      first === undefined || !first.toolsOffered ? null : first.toolCalls.length > 0,
    calls: calls.length,
    retries: result.retries,
    latencyMs: result.latencyMs,
    promptVersion: result.promptVersion,
    error: result.ok ? null : result.error,
    output: cut(result.raw),
  };
}

/** Runs one job and takes the model calls it made. */
async function measured<T>(
  context: EvalContext,
  job: string,
  run: () => Promise<JobResult<T>>,
): Promise<{ result: JobResult<T>; step: StepRecord; calls: LoggedCall[] }> {
  context.log.take();
  const result = await run();
  const calls = context.log.take();
  return { result, step: stepOfJob(job, result, calls), calls };
}

interface CaseMeta {
  readonly id: string;
  readonly note: string | null;
  readonly expect: readonly string[] | undefined;
}

const metaOf = (entry: {
  id: string;
  note?: string | undefined;
  expect?: string[] | undefined;
}): CaseMeta => ({ id: entry.id, note: entry.note ?? null, expect: entry.expect });

function recordOf(
  prepared: CaseMeta,
  steps: readonly StepRecord[],
  primaryStep: string,
  answerKey: string,
): CaseRecord {
  const firstInvalid = steps.find((step) => !step.valid);
  const bookmaker = steps.find((step) => step.job === "bookmaker");
  return {
    id: prepared.id,
    note: prepared.note,
    steps,
    valid: firstInvalid === undefined,
    failure: firstInvalid?.failure ?? null,
    primaryValid: steps.find((step) => step.job === primaryStep)?.valid ?? false,
    toolMode: bookmaker?.toolMode ?? null,
    calls: steps.reduce((sum, step) => sum + step.calls, 0),
    retries: steps.reduce((sum, step) => sum + step.retries, 0),
    latencyMs: steps.reduce((sum, step) => sum + step.latencyMs, 0),
    answerKey,
    matchesExpectation: prepared.expect === undefined ? null : prepared.expect.includes(answerKey),
  };
}

export class EvalCaseError extends Error {
  override readonly name = "EvalCaseError";
}

/** The rule baseline and what the bookmaker is shown, built from synthetic weather like the card flow. */
function bookmakerInputOf(
  context: EvalContext,
  entry: { id: string; chore: ChoreType; text: string; now: string },
  forecast: ReturnType<typeof syntheticForecast>,
  extra: Pick<BookmakerInput, "answers" | "habits" | "observations">,
): BookmakerInput {
  const nowMs = parseNow(entry.now);
  const hours = forecast.hours;
  const sunsetMs = forecast.sunsetMsByDate[madridDateOf(nowMs)];
  const quote = ruleQuoteAt(
    entry.chore,
    hours,
    nowMs,
    CHORES[entry.chore].ruleSettleAt(nowMs),
    context.rules,
    sunsetMs,
  );
  if (quote === null) {
    throw new EvalCaseError(
      `Case ${entry.id}: the synthetic weather does not cover the rule window`,
    );
  }
  return {
    chore: entry.chore,
    label: entry.text,
    nowMs,
    anchorMs: nowMs,
    ruleBand: quote.band,
    ruleBandAt: (settleAtMs) =>
      ruleBandOrFallback(
        entry.chore,
        hours,
        nowMs,
        settleAtMs,
        context.rules,
        quote.band,
        sunsetMs,
      ),
    readForecast: (hoursAhead) => Promise.resolve(forecastFrom(hours, nowMs, hoursAhead)),
    cardId: context.nextCardId(),
    ...extra,
  };
}

function bookmakerKey(step: StepRecord, output: { band?: string | undefined } | undefined): string {
  if (!step.valid) {
    return "invalid";
  }
  return step.status === "unsure" ? "unsure" : (output?.band ?? "invalid");
}

// --- listener --------------------------------------------------------------------------------

const listenerJob: EvalJobSpec = {
  job: "listener",
  primaryStep: "listener",
  photoBudget: false,
  promptVersions: [LISTENER_PROMPT.version],
  prepare: (path) =>
    readCaseFile(path, "listener", listenerCaseSchema).map((entry: ListenerCase): PreparedCase => ({
      id: entry.id,
      note: entry.note ?? null,
      expect: entry.expect,
      photos: [],
      async run(context) {
        const { result, step, calls } = await measured(context, "listener", () =>
          runListener(context.runner, entry.text),
        );
        // The chore types in the order they appear: "plants+laundry_line".
        const key = result.ok
          ? result.output.chores.map((chore) => chore.chore_type).join("+")
          : "invalid";
        return { record: recordOf(metaOf(entry), [step], "listener", key), calls };
      },
    })),
};

// --- bookmaker -------------------------------------------------------------------------------

const bookmakerJob: EvalJobSpec = {
  job: "bookmaker",
  primaryStep: "bookmaker",
  photoBudget: false,
  promptVersions: [BOOKMAKER_PROMPT.version],
  prepare: (path) =>
    readCaseFile(path, "bookmaker", bookmakerCaseSchema).map(
      (entry: BookmakerCase): PreparedCase => ({
        id: entry.id,
        note: entry.note ?? null,
        expect: entry.expect,
        photos: [],
        async run(context) {
          const nowMs = parseNow(entry.now);
          const input = bookmakerInputOf(
            context,
            entry,
            syntheticForecast(entry.weather, nowMs, FORECAST_HOURS, FORECAST_PAST_HOURS),
            { answers: entry.answers, habits: entry.habits },
          );
          const { result, step, calls } = await measured(context, "bookmaker", () =>
            runBookmaker(context.runner, input),
          );
          const key = bookmakerKey(step, result.ok ? result.output : undefined);
          return { record: recordOf(metaOf(entry), [step], "bookmaker", key), calls };
        },
      }),
    ),
};

// --- inspector (and the bookmaker that follows it, NFR-004) -------------------------------------

const inspectorJob: EvalJobSpec = {
  job: "inspector",
  primaryStep: "inspector",
  photoBudget: true,
  promptVersions: [INSPECTOR_PROMPT.version, BOOKMAKER_PROMPT.version],
  prepare: (path) =>
    readCaseFile(path, "inspector", inspectorCaseSchema).map(
      (entry: InspectorCase): PreparedCase => ({
        id: entry.id,
        note: entry.note ?? null,
        expect: entry.expect,
        photos: [{ name: entry.photo, staging: entry.staging }],
        async run(context) {
          const nowMs = parseNow(entry.now);
          const forecast = syntheticForecast(
            entry.weather,
            nowMs,
            FORECAST_HOURS,
            FORECAST_PAST_HOURS,
          );
          const photo = context.photo(entry.photo);
          // One 45 s deadline for the photo, measured from here, as in the live app.
          const enqueuedAt = Date.now();
          const inspected = await measured(context, "inspector", () =>
            runInspector(context.runner, {
              chore: entry.chore,
              image: photo.data,
              width: photo.width,
              height: photo.height,
              cardId: context.nextCardId(),
              photoId: `eval-${entry.id}`,
              enqueuedAt,
            }),
          );
          const steps = [inspected.step];
          const calls = [...inspected.calls];
          const output = inspected.result.ok ? inspected.result.output : undefined;
          if (output?.status === "ok") {
            // The inspector saw enough: the bookmaker is asked again with what it saw.
            const input = bookmakerInputOf(context, entry, forecast, {
              answers: [],
              observations: output.observations ?? [],
            });
            const bookmaked = await measured(context, "bookmaker", () =>
              runBookmaker(context.runner, { ...input, enqueuedAt }),
            );
            steps.push(bookmaked.step);
            calls.push(...bookmaked.calls);
          }
          const key = !inspected.step.valid
            ? "invalid"
            : inspected.step.status === "unsure"
              ? "unsure"
              : "ok";
          return { record: recordOf(metaOf(entry), steps, "inspector", key), calls };
        },
      }),
    ),
};

// --- judge -----------------------------------------------------------------------------------

function judgeEvidence(entry: JudgeCase, context: EvalContext): JudgeEvidence {
  switch (entry.evidence.kind) {
    case "tap":
      return { kind: "tap", answerId: entry.evidence.answer };
    case "weather":
      return { kind: "weather" };
    case "photo": {
      const before = entry.evidence.before;
      return {
        kind: "photo",
        ...(before === undefined ? {} : { before: context.photo(before).data }),
        after: context.photo(entry.evidence.after).data,
      };
    }
  }
}

const judgeJob: EvalJobSpec = {
  job: "judge",
  primaryStep: "judge",
  photoBudget: false,
  promptVersions: [JUDGE_PROMPT.version],
  prepare: (path) =>
    readCaseFile(path, "judge", judgeCaseSchema).map((entry: JudgeCase): PreparedCase => {
      const evidence = entry.evidence;
      return {
        id: entry.id,
        note: entry.note ?? null,
        expect: entry.expect,
        photos:
          evidence.kind === "photo"
            ? [
                ...(evidence.before === undefined
                  ? []
                  : [{ name: evidence.before, staging: evidence.staging }]),
                { name: evidence.after, staging: evidence.staging },
              ]
            : [],
        async run(context) {
          // The bet's window starts at a fixed synthetic time; only its digest reaches the judge.
          const fromMs = madridWallTimeToEpochMs("2026-07-01", "06:00");
          const digest =
            entry.weather === null
              ? null
              : digestOf(syntheticRecorded(entry.weather, fromMs, entry.weatherHours));
          context.log.take();
          const result = await judgeBet(context.runner, {
            chore: entry.chore === LAUNDRY_PLAN ? LAUNDRY_PLAN_SPEC : CHORES[entry.chore],
            kind: entry.kind,
            odds: entry.odds,
            evidence: judgeEvidence(entry, context),
            weather: digest,
            followups: entry.followups,
            canAsk: entry.canAsk,
            betId: context.nextCardId(),
          });
          const calls = context.log.take();
          const first = calls[0];
          const unsure = !result.ok && result.failure === "unsure";
          const valid = result.ok || unsure;
          const retries =
            context.db
              .prepare<[number], { retries: number }>(
                "SELECT retries FROM gemma_decisions WHERE id = ?",
              )
              .get(result.decisionId)?.retries ?? 0;
          const failure: JobFailure | "unsure" | null = result.ok || unsure ? null : result.failure;
          const step: StepRecord = {
            job: "judge",
            valid,
            failure,
            status: valid ? (result.ok ? "ok" : "unsure") : null,
            toolMode: null,
            firstAnswerHadToolCall:
              first === undefined || !first.toolsOffered ? null : first.toolCalls.length > 0,
            calls: calls.length,
            retries,
            latencyMs: result.latencyMs,
            promptVersion: JUDGE_PROMPT.version,
            error: !result.ok && !unsure ? result.error : null,
            output: cut(result.raw),
          };
          const key = result.ok ? result.verdict : unsure ? "unsure" : "invalid";
          return { record: recordOf(metaOf(entry), [step], "judge", key), calls };
        },
      };
    }),
};

// --- safety guard ------------------------------------------------------------------------------

const safetyJob: EvalJobSpec = {
  job: "safety",
  primaryStep: "safety",
  photoBudget: false,
  promptVersions: [SAFETY_PROMPT.version],
  prepare: (path) =>
    readCaseFile(path, "safety", safetyCaseSchema).map((entry: SafetyCase): PreparedCase => ({
      id: entry.id,
      note: entry.note ?? null,
      expect: entry.expect,
      photos: [],
      async run(context) {
        const nowMs = parseNow(entry.now);
        const forecast = syntheticForecast(
          entry.weather,
          nowMs,
          FORECAST_HOURS,
          FORECAST_PAST_HOURS,
        );
        const sunsetMs = forecast.sunsetMsByDate[madridDateOf(nowMs)];
        // The card's rule window, as the live guard reads it.
        const window = ruleWindowAt(
          entry.chore,
          nowMs,
          CHORES[entry.chore].ruleSettleAt(nowMs),
          sunsetMs,
        );
        const { result, step, calls } = await measured(context, "safety", () =>
          runSafetyGuard(context.runner, {
            chore: entry.chore,
            label: entry.text,
            nowMs,
            window,
            forecast: hoursInWindow(forecast.hours, window.fromMs, window.toMs).sort(
              (a, b) => a.startsAt - b.startsAt,
            ),
            cardId: context.nextCardId(),
          }),
        );
        const key = !result.ok
          ? "invalid"
          : result.output.status === "unsure"
            ? "unsure"
            : result.output.alert === true
              ? "alert"
              : "no_alert";
        return { record: recordOf(metaOf(entry), [step], "safety", key), calls };
      },
    })),
};

// --- laundry planner -----------------------------------------------------------------------------

const plannerJob: EvalJobSpec = {
  job: "laundry-planner",
  primaryStep: "laundry-planner",
  photoBudget: false,
  promptVersions: [LAUNDRY_PLANNER_PROMPT.version],
  prepare: (path) =>
    readCaseFile(path, "laundry-planner", plannerCaseSchema).map(
      (entry: PlannerCase): PreparedCase => ({
        id: entry.id,
        note: entry.note ?? null,
        expect: entry.expect,
        photos: [],
        async run(context) {
          const nowMs = parseNow(entry.now);
          const forecast = syntheticForecast(
            entry.weather,
            nowMs,
            PLAN_FORECAST_HOURS,
            FORECAST_PAST_HOURS,
          );
          const input: LaundryPlannerInput = {
            label: entry.text,
            nowMs,
            days: planDayFacts(forecast.hours, nowMs, nowMs, context.rules),
            answers: entry.answers,
            cardId: context.nextCardId(),
          };
          const { result, step, calls } = await measured(context, "laundry-planner", () =>
            runLaundryPlanner(context.runner, input),
          );
          const key = !result.ok
            ? "invalid"
            : result.output.status === "unsure"
              ? "unsure"
              : (result.output.state ?? "invalid");
          return { record: recordOf(metaOf(entry), [step], "laundry-planner", key), calls };
        },
      }),
    ),
};

export const EVAL_JOB_SPECS: Readonly<Record<EvalJob, EvalJobSpec>> = {
  listener: listenerJob,
  bookmaker: bookmakerJob,
  inspector: inspectorJob,
  judge: judgeJob,
  safety: safetyJob,
  "laundry-planner": plannerJob,
};
