import type { FastifyPluginAsync } from "fastify";

import { householdSchema, type Household } from "./config.js";
import type { HouseholdStore } from "./household-store.js";
import { HttpError } from "./problem.js";

/**
 * The answers of the form. Every question is required (an empty list of outdoor items is an
 * answer), and nothing else is accepted.
 */
const answersSchema = householdSchema.required({ location: true, outdoorItems: true }).strict();

function view(store: HouseholdStore): {
  state: ReturnType<HouseholdStore["state"]>;
  household: Household;
} {
  return { state: store.state(), household: store.forForm() };
}

/**
 * GET/PUT /api/onboarding and POST /api/onboarding/skip (REQ-024). Registered only while the
 * `onboarding` flag is on (AC-029.2): with it off the routes do not exist.
 */
export function householdRoutes(store: HouseholdStore): FastifyPluginAsync {
  return (app) => {
    app.get("/api/onboarding", () => view(store));

    app.put("/api/onboarding", (request) => {
      const result = answersSchema.safeParse(request.body);
      if (!result.success) {
        throw new HttpError(
          400,
          "Invalid request",
          result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        );
      }
      store.save(result.data);
      return view(store);
    });

    app.post("/api/onboarding/skip", () => {
      if (store.state() !== "pending") {
        throw new HttpError(409, "Already answered", "Onboarding was answered already.");
      }
      store.skip();
      return view(store);
    });
    return Promise.resolve();
  };
}
