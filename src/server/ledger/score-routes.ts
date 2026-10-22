import type { FastifyPluginAsync } from "fastify";

import type { LedgerDeps } from "./deps.js";
import { getScore } from "./score.js";

/** GET /api/score (REQ-020). Registered only while the `score` flag is on (AC-029.2). */
export function scoreRoutes(
  deps: Pick<LedgerDeps, "db" | "rules" | "flags" | "now">,
): FastifyPluginAsync {
  return (app) => {
    app.get("/api/score", () => getScore(deps));
    return Promise.resolve();
  };
}
