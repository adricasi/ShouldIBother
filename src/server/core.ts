import multipart from "@fastify/multipart";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { CHORE_TYPES } from "../domain/chores.js";
import type { SavingsCatalogue } from "../domain/savings.js";
import type { RulesConfig } from "../domain/rules/index.js";
import { ATTRIBUTION } from "../domain/open-meteo.js";
import { forecastAgeLabel } from "../domain/weather.js";

import type { Household } from "./config.js";
import type { Db } from "./db.js";
import { FLAG_NAMES, type Flags } from "./flags.js";
import { householdRoutes } from "./household-routes.js";
import { HouseholdStore } from "./household-store.js";
import { GemmaStatusMonitor } from "./gemma/status.js";
import { JobRunner, type RunnerOptions } from "./gemma/runner.js";
import { listDueBets, listBetsWithStatus, markDueBets, placeBet, undoBet } from "./ledger/bets.js";
import { createQuickCard, getCardView, listOpenCards } from "./ledger/cards.js";
import { captureText, MAX_CAPTURE_CHARS } from "./ledger/capture.js";
import { Appealer } from "./ledger/appeal.js";
import { appealRoutes } from "./ledger/appeal-routes.js";
import { BackgroundTasks, type LedgerDeps } from "./ledger/deps.js";
import {
  answerCard,
  assertGemmaCapacity,
  recoverThinkingCards,
  resumeUnguardedCards,
  retryCard,
} from "./ledger/gemma-cards.js";
import { answerPlannerQuestion, plannerCardId, retryPlanner } from "./ledger/laundry-plan.js";
import { laundryPlanRoutes } from "./ledger/laundry-plan-routes.js";
import { sweepOrphanPhotos } from "./ledger/photos.js";
import { recoverInspections, startInspection } from "./ledger/photo-odds.js";
import { pointsTotal } from "./ledger/points.js";
import { getReceipt } from "./ledger/receipt.js";
import { cashOutBet, runRescueChecks } from "./ledger/rescue.js";
import { backfillSavingsSnapshots, weekSavings } from "./ledger/savings.js";
import { scoreRoutes } from "./ledger/score-routes.js";
import { Settler, type SettleOutcome } from "./ledger/settle.js";
import { getSlips } from "./ledger/slips.js";
import { weatherBoardView } from "./ledger/weather-board.js";
import { voiceRoutes } from "./voice/routes.js";
import { MULTIPART_OPTIONS, photoRoutes, readUploadedPhoto } from "./photos/routes.js";
import type { PhotoStore } from "./photos/store.js";
import { HttpError } from "./problem.js";
import { createScheduler, type Scheduler } from "./scheduler.js";
import type { ModelClient } from "./model/client.js";
import { FORECAST_TTL_MS, type WeatherClient } from "./weather/client.js";

export interface CoreDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly weather: WeatherClient;
  readonly model: ModelClient;
  readonly rules: RulesConfig;
  /** The flags, exposed to the SPA so it can hide entry points of features that are off. */
  readonly flags: Flags;
  /** True in `sib demo`: the SPA shows its "Sample data" banner (AC-029.4). */
  readonly demo?: boolean;
  /** The household baseline behind "Not needed this season" (AC-016.5). */
  readonly household: Household;
  /**
   * The onboarding answers (flag `onboarding`). Only read while the flag is on; omitted, the core
   * makes its own over the same database.
   */
  readonly householdStore?: HouseholdStore;
  /** What one won bet saves per chore (REQ-011). */
  readonly savings: SavingsCatalogue;
  /** The photo files in the data folder (REQ-005, REQ-015). */
  readonly photos: PhotoStore;
  readonly onSchedulerError?: (error: unknown) => void;
  /** Called when a background Gemma step fails unexpectedly (not for ordinary Gemma failures). */
  readonly onBackgroundError?: (error: unknown) => void;
  /** Timeouts and tool settings of the job runner; the fixed values by default. */
  readonly runner?: Omit<RunnerOptions, "model" | "db" | "now">;
}

/** The core loop: capture, bet, settle. Always on; flagged features are separate plugins. */
export interface Core {
  readonly plugin: FastifyPluginAsync;
  readonly scheduler: Scheduler;
  readonly gemma: JobRunner;
  /** Resolves when no Gemma job is queued or running and no card is waiting on one. */
  idle(): Promise<void>;
}

const quickCardBody = z.object({ chore_type: z.enum(CHORE_TYPES) }).strict();
const captureBody = z.object({ text: z.string().trim().min(1).max(MAX_CAPTURE_CHARS) }).strict();
const answerBody = z.object({ yes: z.boolean() }).strict();
const placeBetBody = z
  .object({
    card_id: z.number().int().positive(),
    quote_id: z.number().int().positive(),
    kind: z.enum(["do_nothing", "do_it"]),
  })
  .strict();
const settleBody = z.object({ answer: z.string().min(1).max(40) }).strict();
const idParams = z.object({ id: z.coerce.number().int().positive() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      400,
      "Invalid request",
      result.error.issues.map((i) => i.message).join("; "),
    );
  }
  return result.data;
}

function sendProblem(reply: FastifyReply, error: HttpError): FastifyReply {
  return reply
    .code(error.status)
    .header("content-type", "application/problem+json")
    .send({
      type: "about:blank",
      title: error.title,
      status: error.status,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    });
}

/** How old the forecast behind the odds is, for Today (AC-014.3). Null before the first fetch. */
function forecastStatus(deps: CoreDeps) {
  const fetchedAt = deps.weather.latestForecastFetchedAt();
  if (fetchedAt === undefined) {
    return null;
  }
  const ageMs = Math.max(0, deps.now() - fetchedAt);
  return {
    fetched_at: new Date(fetchedAt).toISOString(),
    age_label: forecastAgeLabel(ageMs),
    // Older than the 1 h cache means Open-Meteo could not be reached for a fresh one.
    stale: ageMs >= FORECAST_TTL_MS,
  };
}

export function createCore(deps: CoreDeps): Core {
  const gemma = new JobRunner({
    model: deps.model,
    db: deps.db,
    now: deps.now,
    ...deps.runner,
  });
  let logEntry: LedgerDeps["log"] = () => undefined;
  // Onboarding (REQ-024): with the flag off nothing reads the store and the baseline is the
  // config file, as before the feature existed.
  const householdStore = deps.flags.onboarding
    ? (deps.householdStore ??
      new HouseholdStore(deps.db, deps.household, deps.now, (entry) => {
        logEntry(entry);
      }))
    : undefined;
  const ledger: LedgerDeps = {
    log: (entry) => {
      logEntry(entry);
    },
    db: deps.db,
    now: deps.now,
    weather: deps.weather,
    gemma,
    rules: deps.rules,
    // Read at every use: a bet takes the household of the moment it is placed (AC-024.2).
    get household() {
      return householdStore?.current() ?? deps.household;
    },
    flags: deps.flags,
    ...(deps.demo === true ? { demo: true } : {}),
    savings: deps.savings,
    photos: deps.photos,
    background: new BackgroundTasks(deps.onBackgroundError ?? (() => undefined)),
  };
  const settler = new Settler(ledger);
  const scheduler = createScheduler(deps, deps.onSchedulerError ?? (() => undefined), {
    settle: () => settler.runPass(),
    // Rescue alerts re-check the forecast of open bets; off by default (REQ-022, REQ-029).
    ...(deps.flags.rescue ? { rescue: () => runRescueChecks(ledger) } : {}),
  });
  // Bets placed before savings existed (the first real bets) get their snapshot once (REQ-011).
  backfillSavingsSnapshots(ledger);
  // Photo-store warnings (a file that could not be removed, a checkpoint that could not finish)
  // go to the structured log: messages only, never photo content.
  deps.photos.warn = (message) => {
    logEntry({ event: "photo_warning", message });
  };
  // A job with a model of its own (the fine-tuned bookmaker) shows up in the status when that
  // model cannot answer, with one log line when it first fails.
  const bookmakerModel = deps.runner?.jobModels?.["bookmaker"];
  const status = new GemmaStatusMonitor(deps.model, deps.now, undefined, {
    ...(bookmakerModel === undefined
      ? {}
      : { watched: [{ label: "The fine-tuned bookmaker", model: bookmakerModel }] }),
    onWarning: (message) => {
      logEntry({ event: "gemma_model_warning", message });
    },
  });
  // A card still "thinking" lost its job with the previous process (NFR-003).
  recoverThinkingCards(ledger);
  resumeUnguardedCards(ledger);
  recoverInspections(ledger);
  sweepOrphanPhotos(ledger);

  const plugin: FastifyPluginAsync = async (app) => {
    // Household data: never cached by the browser or a proxy (a route may set a stricter value).
    gemma.setLogger((entry) => {
      app.log.info(entry, "gemma job");
    });
    logEntry = (entry) => {
      app.log.info(entry, "gemma card");
    };
    // The after photo of a settlement arrives as multipart; the card photo route shares the parser.
    await app.register(multipart, MULTIPART_OPTIONS);
    app.addHook("onSend", (_request, reply, payload) => {
      if (!reply.hasHeader("cache-control")) {
        reply.header("cache-control", "no-store");
      }
      return Promise.resolve(payload);
    });
    app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof HttpError) {
        return sendProblem(reply, error);
      }
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== undefined && status >= 400 && status < 500) {
        return sendProblem(reply, new HttpError(status, "Bad Request"));
      }
      request.log.error({ err: error }, "unhandled error");
      return sendProblem(reply, new HttpError(500, "Internal Server Error"));
    });

    app.get("/api/today", async () => {
      // Due is decided at read time too, so a bet is never listed as waiting after its settle time.
      markDueBets(deps.db, deps.now());
      const gemmaStatus = await status.get();
      return {
        now: new Date(deps.now()).toISOString(),
        demo: deps.demo === true,
        flags: Object.fromEntries(FLAG_NAMES.map((name) => [name, deps.flags[name]])),
        gemma: {
          status: gemmaStatus.state,
          detail: gemmaStatus.detail ?? null,
          checked_at: new Date(gemmaStatus.checkedAt).toISOString(),
          ...(gemmaStatus.warning === undefined ? {} : { warning: gemmaStatus.warning }),
        },
        points: { total: pointsTotal(ledger) },
        week: weekSavings(ledger),
        forecast: forecastStatus(deps),
        attribution: ATTRIBUTION,
        // Only with the `splitFlap` flag on: the weather board reads the cached forecast (REQ-026).
        // The place label shows only while `onboarding` is on too (AC-026.3).
        ...(deps.flags.splitFlap
          ? { weather_board: weatherBoardView(ledger, householdStore?.placeLabel() ?? null) }
          : {}),
        cards: listOpenCards(ledger),
        open_bets: listBetsWithStatus(ledger, "open"),
        due_bets: listDueBets(ledger),
      };
    });

    // Typed capture: the listener finds the chores, one card each (AC-002.1).
    app.post("/api/cards", async (request, reply) => {
      const body = parse(captureBody, request.body);
      return reply.code(201).send({ cards: await captureText(ledger, body.text) });
    });

    app.post("/api/cards/quick", async (request, reply) => {
      const body = parse(quickCardBody, request.body);
      return reply.code(201).send(await createQuickCard(ledger, body.chore_type));
    });

    app.get("/api/cards/:id", (request) => getCardView(ledger, parse(idParams, request.params).id));

    app.post("/api/cards/:id/retry", (request) => {
      const { id } = parse(idParams, request.params);
      // A laundry planner card (flag `laundryPlanner`) is retried by the planner, not the bookmaker.
      return deps.flags.laundryPlanner && plannerCardId(ledger, id)
        ? retryPlanner(ledger, id)
        : retryCard(ledger, id);
    });

    app.post("/api/cards/:id/answer", (request) => {
      const { id } = parse(idParams, request.params);
      const yes = parse(answerBody, request.body).yes;
      return deps.flags.laundryPlanner && plannerCardId(ledger, id)
        ? answerPlannerQuestion(ledger, id, yes)
        : answerCard(ledger, id, yes);
    });

    app.post("/api/bets", (request, reply) => {
      const body = parse(placeBetBody, request.body);
      return reply.code(201).send(placeBet(ledger, body.card_id, body.quote_id, body.kind));
    });

    app.delete("/api/bets/:id", (request) => undoBet(ledger, parse(idParams, request.params).id));

    app.get("/api/slips", () => getSlips(ledger));

    /** The judge's verdict, a question, or the saved answer waiting for the weather or Gemma. */
    const outcomeResponse = (outcome: SettleOutcome, reply: FastifyReply): FastifyReply => {
      switch (outcome.state) {
        case "settled":
          return reply.send({ state: "settled", receipt: outcome.receipt });
        case "question":
          return reply.send(outcome);
        case "awaiting_weather":
          return reply.code(202).send({
            state: "awaiting_weather",
            note: "Your answer is saved. The recorded weather is not in yet; it settles when it is.",
          });
        case "awaiting_gemma":
          return reply.code(202).send({
            state: "awaiting_gemma",
            note: "Your answer is saved. It settles when Gemma is back.",
          });
        case "answer_needed":
          return reply.code(202).send({
            state: "answer_needed",
            note: "Your photo is no longer there. Please answer again.",
          });
      }
    };

    // One tap (JSON) or an after photo (multipart): the answer is stored, then the judge decides.
    app.post("/api/bets/:id/settle", async (request, reply) => {
      const { id } = parse(idParams, request.params);
      if (request.isMultipart()) {
        // Refuse a bet that cannot take an answer before the upload is buffered.
        settler.checkPhotoAnswer(id);
        const bytes = await readUploadedPhoto(request);
        return outcomeResponse(await settler.submitPhoto(id, bytes), reply);
      }
      const body = parse(settleBody, request.body);
      return outcomeResponse(await settler.submitTap(id, body.answer), reply);
    });

    // The tap on the judge's yes/no question (AC-008.5).
    app.post("/api/bets/:id/answer", async (request, reply) => {
      const { id } = parse(idParams, request.params);
      return outcomeResponse(
        await settler.answerQuestion(id, parse(answerBody, request.body).yes),
        reply,
      );
    });

    app.get("/api/bets/:id/receipt", (request) =>
      getReceipt(ledger, parse(idParams, request.params).id),
    );

    await app.register(
      photoRoutes({
        deps: ledger,
        checkCapacity: () => {
          assertGemmaCapacity(ledger);
        },
        afterStored: ({ cardId, photo }) => {
          startInspection(ledger, cardId, photo.id);
          return { photo, card: getCardView(ledger, cardId) };
        },
      }),
    );

    // Flagged: with `rescue` off the route does not exist and a request gets a plain 404 (AC-029.2).
    if (deps.flags.rescue) {
      app.post("/api/bets/:id/cashout", (request) =>
        cashOutBet(ledger, parse(idParams, request.params).id),
      );
    }

    // Flagged: with `score` off the route does not exist and a request gets a plain 404.
    if (deps.flags.score) {
      await app.register(scoreRoutes(ledger));
    }
    // Flagged: onboarding (REQ-024) has no routes while `onboarding` is off.
    if (householdStore !== undefined) {
      await app.register(householdRoutes(householdStore));
    }
    // Flagged: appeals (REQ-023) have no route while `appeals` is off.
    if (deps.flags.appeals) {
      await app.register(appealRoutes(new Appealer(ledger)));
    }
    // Flagged: voice capture (REQ-027) has no routes while `voice` is off.
    if (deps.flags.voice) {
      await app.register(voiceRoutes(ledger));
    }
    // Flagged: the laundry planner (REQ-021) has no routes while `laundryPlanner` is off.
    if (deps.flags.laundryPlanner) {
      await app.register(laundryPlanRoutes(ledger));
    }
  };

  return {
    plugin,
    scheduler,
    gemma,
    idle: async () => {
      await gemma.idle();
      await ledger.background.idle();
    },
  };
}
