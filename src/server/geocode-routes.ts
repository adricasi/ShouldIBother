import type { FastifyPluginAsync } from "fastify";

import {
  GEOCODE_SEARCHES_PER_MINUTE,
  languageFromAcceptLanguage,
  parseGeocodeQuery,
} from "../domain/geocode.js";

import { sessionKeyOf } from "./auth/guard.js";
import { SlidingWindowLimiter } from "./auth/rate-limit.js";
import { HttpError } from "./problem.js";
import { CallBudgetExhaustedError } from "./weather/cache.js";
import { WeatherUnavailableError } from "./weather/client.js";
import type { Geocoder } from "./weather/geocoding.js";

const OFFLINE_TITLE = "Search is offline; type the coordinates";
const CAP_TITLE = "Search limit reached for today; type the coordinates";
const BUSY_DETAIL =
  "That is a lot of searches in a minute. Please wait a moment and search again, or type the coordinates.";

/**
 * GET /api/geocode?q= for the onboarding place search (AC-024.4). Registered only while the
 * `onboarding` flag is on, so with it off the route does not exist and a request gets a 404.
 *
 * The typed text is handled as little as possible: it is validated, sent once to the geocoder, and
 * dropped. It is not logged (the request logger drops every query string and the problems below
 * never repeat it), not cached (`no-store`), not stored, and nothing here reaches a Gemma prompt.
 * Searches are limited per session to 10 a minute, counted before the text is even checked, so a
 * script cannot probe the validation for free.
 */
export function geocodeRoutes(options: {
  readonly geocoder: Geocoder;
  readonly now: () => number;
}): FastifyPluginAsync {
  const limiter = new SlidingWindowLimiter(options.now, GEOCODE_SEARCHES_PER_MINUTE);
  return (app) => {
    // No HEAD twin: a HEAD request must not spend a search, a rate-limit slot or the day's cap.
    app.get("/api/geocode", { exposeHeadRoute: false }, async (request, reply) => {
      // Every request that passed the guard has a session; the fallback is a single shared bucket.
      const waitSeconds = limiter.take(sessionKeyOf(request) ?? "no-session");
      if (waitSeconds > 0) {
        return reply
          .code(429)
          .header("retry-after", String(waitSeconds))
          .header("content-type", "application/problem+json")
          .send({
            type: "about:blank",
            title: "Too many searches",
            status: 429,
            detail: BUSY_DETAIL,
          });
      }
      const { q } = request.query as { q?: unknown };
      const parsed = parseGeocodeQuery(q);
      if (!parsed.ok) {
        throw new HttpError(400, "Invalid request", parsed.problem);
      }
      const language = languageFromAcceptLanguage(request.headers["accept-language"]);
      try {
        return { results: await options.geocoder.search(parsed.query, language) };
      } catch (error) {
        if (error instanceof CallBudgetExhaustedError) {
          throw new HttpError(503, CAP_TITLE);
        }
        if (error instanceof WeatherUnavailableError) {
          throw new HttpError(503, OFFLINE_TITLE);
        }
        throw error;
      }
    });
    return Promise.resolve();
  };
}
