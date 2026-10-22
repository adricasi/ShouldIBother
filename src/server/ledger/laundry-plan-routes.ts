import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { MAX_CAPTURE_CHARS } from "../gemma/listener.js";
import { HttpError } from "../problem.js";

import type { LedgerDeps } from "./deps.js";
import { answerNeed, createPlannerCard, followAdvice } from "./laundry-plan.js";

const createBody = z
  .object({ text: z.string().trim().min(1).max(MAX_CAPTURE_CHARS).optional() })
  .strict();
const needBody = z.object({ needed: z.boolean() }).strict();
const idParams = z.object({ id: z.coerce.number().int().positive() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      400,
      "Invalid request",
      result.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return result.data;
}

/**
 * The laundry planner's routes (REQ-021). Registered only while the `laundryPlanner` flag is on,
 * so with it off they do not exist and a request gets a plain 404 (AC-029.2).
 *
 * - `POST /api/laundry-plan` makes a planner card (the Gemma job runs after the response).
 * - `POST /api/laundry-plan/:id/need` answers "Need anything washed before <day>?" (AC-021.2).
 * - `POST /api/laundry-plan/:id/follow` follows Wash today (AC-021.3).
 *
 * Retry and Gemma's own question use the card routes, which hand a planner card to the planner.
 */
export function laundryPlanRoutes(deps: LedgerDeps): FastifyPluginAsync {
  return (app) => {
    app.post("/api/laundry-plan", (request, reply) => {
      const body = parse(createBody, request.body ?? {});
      return reply.code(201).send(createPlannerCard(deps, body.text));
    });
    app.post("/api/laundry-plan/:id/need", (request) => {
      const { id } = parse(idParams, request.params);
      return answerNeed(deps, id, parse(needBody, request.body).needed);
    });
    app.post("/api/laundry-plan/:id/follow", (request) =>
      followAdvice(deps, parse(idParams, request.params).id),
    );
    return Promise.resolve();
  };
}
