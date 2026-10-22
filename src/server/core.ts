import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { CHORE_TYPES } from "../domain/chores.js";

import { FLAG_NAMES, type Flags } from "./flags.js";
import { listBetsWithStatus, markDueBets, placeBet, undoBet } from "./ledger/bets.js";
import { createQuickCard, getCardView, listOpenCards } from "./ledger/cards.js";
import type { LedgerDeps } from "./ledger/deps.js";
import { pointsTotal, settleByTap } from "./ledger/settle.js";
import { getSlips } from "./ledger/slips.js";
import { HttpError } from "./problem.js";
import { createScheduler, type Scheduler } from "./scheduler.js";

export interface CoreDeps extends LedgerDeps {
  /** The flags, exposed to the SPA so it can hide entry points of features that are off. */
  readonly flags: Flags;
  readonly onSchedulerError?: (error: unknown) => void;
}

/** The core loop: capture, bet, settle. Always on; flagged features are separate plugins. */
export interface Core {
  readonly plugin: FastifyPluginAsync;
  readonly scheduler: Scheduler;
}

const quickCardBody = z.object({ chore_type: z.enum(CHORE_TYPES) }).strict();
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

export function createCore(deps: CoreDeps): Core {
  const scheduler = createScheduler(deps, deps.onSchedulerError ?? (() => undefined));

  const plugin: FastifyPluginAsync = (app) => {
    // Household data: never cached by the browser or a proxy.
    app.addHook("onSend", (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
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

    app.get("/api/today", () => {
      // Due is decided at read time too, so a bet is never listed as waiting after its settle time.
      markDueBets(deps.db, deps.now());
      return {
        now: new Date(deps.now()).toISOString(),
        flags: Object.fromEntries(FLAG_NAMES.map((name) => [name, deps.flags[name]])),
        points: { total: pointsTotal(deps) },
        cards: listOpenCards(deps),
        open_bets: listBetsWithStatus(deps, "open"),
        due_bets: listBetsWithStatus(deps, "due"),
      };
    });

    app.post("/api/cards/quick", async (request, reply) => {
      const body = parse(quickCardBody, request.body);
      return reply.code(201).send(await createQuickCard(deps, body.chore_type));
    });

    app.get("/api/cards/:id", (request) => getCardView(deps, parse(idParams, request.params).id));

    app.post("/api/bets", (request, reply) => {
      const body = parse(placeBetBody, request.body);
      return reply.code(201).send(placeBet(deps, body.card_id, body.quote_id, body.kind));
    });

    app.delete("/api/bets/:id", (request) => undoBet(deps, parse(idParams, request.params).id));

    app.get("/api/slips", () => getSlips(deps));

    app.post("/api/bets/:id/settle", async (request) => {
      const { id } = parse(idParams, request.params);
      const body = parse(settleBody, request.body);
      return settleByTap(deps, id, body.answer);
    });
    return Promise.resolve();
  };

  return { plugin, scheduler };
}
