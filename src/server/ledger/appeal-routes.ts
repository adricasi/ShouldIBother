import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { HttpError } from "../problem.js";
import { readUploadedPhoto } from "../photos/routes.js";

import type { Appealer } from "./appeal.js";

const idParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * `POST /api/bets/:id/appeal` (REQ-023): one new photo (multipart) for a settled bet. Registered
 * only while the `appeals` flag is on, so with it off the route does not exist and a request gets
 * a plain 404 (AC-029.2). Answers 200 with the receipt of the second, final verdict.
 *
 * Every refusal that needs no upload (unknown bet, nothing to appeal, already appealed, Gemma
 * busy) comes before the body is read.
 */
export function appealRoutes(appealer: Appealer): FastifyPluginAsync {
  return (app) => {
    app.post("/api/bets/:id/appeal", async (request) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) {
        throw new HttpError(400, "Invalid request", "Bad id");
      }
      const { id } = params.data;
      if (!request.isMultipart()) {
        throw new HttpError(415, "An appeal needs a photo", "Send the new photo as a file.");
      }
      appealer.check(id);
      const bytes = await readUploadedPhoto(request);
      return { state: "settled", receipt: await appealer.appeal(id, bytes) };
    });
    return Promise.resolve();
  };
}
