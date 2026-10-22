import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { CHORE_TYPES } from "../domain/chores.js";
import type { RulesConfig } from "../domain/rules/index.js";
import { ATTRIBUTION } from "../domain/open-meteo.js";
import { forecastAgeLabel } from "../domain/weather.js";

import type { Household } from "./config.js";
import type { Db } from "./db.js";
import { FLAG_NAMES, type Flags } from "./flags.js";
import { GemmaStatusMonitor } from "./gemma/status.js";
import { JobRunner, type RunnerOptions } from "./gemma/runner.js";
import { listBetsWithStatus, markDueBets, placeBet, undoBet } from "./ledger/bets.js";
import { createQuickCard, getCardView, listOpenCards } from "./ledger/cards.js";
import { captureText, MAX_CAPTURE_CHARS } from "./ledger/capture.js";
import { BackgroundTasks, type LedgerDeps } from "./ledger/deps.js";
import { answerCard, recoverThinkingCards, retryCard } from "./ledger/gemma-cards.js";
import { recoverInspections, startInspection } from "./ledger/photo-odds.js";
import { pointsTotal, settleByTap } from "./ledger/settle.js";
import { getSlips } from "./ledger/slips.js";
import { photoRoutes } from "./photos/routes.js";
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
  /** The household baseline behind "Not needed this season" (AC-016.5). */
  readonly household: Household;
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
  const scheduler = createScheduler(deps, deps.onSchedulerError ?? (() => undefined));
  const gemma = new JobRunner({
    model: deps.model,
    db: deps.db,
    now: deps.now,
    ...deps.runner,
  });
  const ledger: LedgerDeps = {
    db: deps.db,
    now: deps.now,
    weather: deps.weather,
    gemma,
    rules: deps.rules,
    household: deps.household,
    flags: deps.flags,
    photos: deps.photos,
    background: new BackgroundTasks(deps.onBackgroundError ?? (() => undefined)),
  };
  const status = new GemmaStatusMonitor(deps.model, deps.now);
  // A card still "thinking" lost its job with the previous process (NFR-003).
  recoverThinkingCards(ledger);
  recoverInspections(ledger);

  const plugin: FastifyPluginAsync = async (app) => {
    // Household data: never cached by the browser or a proxy (a route may set a stricter value).
    gemma.setLogger((entry) => {
      app.log.info(entry, "gemma job");
    });
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
        flags: Object.fromEntries(FLAG_NAMES.map((name) => [name, deps.flags[name]])),
        gemma: {
          status: gemmaStatus.state,
          detail: gemmaStatus.detail ?? null,
          checked_at: new Date(gemmaStatus.checkedAt).toISOString(),
        },
        points: { total: pointsTotal(ledger) },
        forecast: forecastStatus(deps),
        attribution: ATTRIBUTION,
        cards: listOpenCards(ledger),
        open_bets: listBetsWithStatus(ledger, "open"),
        due_bets: listBetsWithStatus(ledger, "due"),
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

    app.post("/api/cards/:id/retry", (request) =>
      retryCard(ledger, parse(idParams, request.params).id),
    );

    app.post("/api/cards/:id/answer", (request) => {
      const { id } = parse(idParams, request.params);
      return answerCard(ledger, id, parse(answerBody, request.body).yes);
    });

    app.post("/api/bets", (request, reply) => {
      const body = parse(placeBetBody, request.body);
      return reply.code(201).send(placeBet(ledger, body.card_id, body.quote_id, body.kind));
    });

    app.delete("/api/bets/:id", (request) => undoBet(ledger, parse(idParams, request.params).id));

    app.get("/api/slips", () => getSlips(ledger));

    app.post("/api/bets/:id/settle", async (request) => {
      const { id } = parse(idParams, request.params);
      const body = parse(settleBody, request.body);
      return settleByTap(ledger, id, body.answer);
    });

    await app.register(
      photoRoutes({
        deps: ledger,
        afterStored: ({ cardId, photo }) => {
          startInspection(ledger, cardId, photo.id);
          return { photo, card: getCardView(ledger, cardId) };
        },
      }),
    );
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
