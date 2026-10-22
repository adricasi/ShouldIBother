import multipart from "@fastify/multipart";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { HttpError } from "../problem.js";
import type { LedgerDeps } from "../ledger/deps.js";
import {
  addBeforePhoto,
  deleteBetData,
  deletePhoto,
  getPhotoRow,
  photoView,
  unsupportedPhoto,
} from "../ledger/photos.js";

import { MAX_UPLOAD_BYTES } from "./process.js";

const betIdParams = z.object({ id: z.coerce.number().int().positive() });

const photoIdParams = z.object({ id: z.string().min(1).max(64) });

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new HttpError(400, "Invalid request", "Bad id");
  }
  return result.data;
}

function parseBetId(params: unknown): number {
  return parseParams(betIdParams, params).id;
}

export interface PhotoRouteOptions {
  readonly deps: Pick<LedgerDeps, "db" | "now" | "photos">;
  /** Throws 503 when Gemma's queue is full; called before the photo is read or any state changes. */
  readonly checkCapacity: () => void;
  /** Runs after the row exists and returns the body of the 201 response (the inspector hooks in here). */
  readonly afterStored: (input: { cardId: number; photo: ReturnType<typeof photoView> }) => unknown;
}

/**
 * Photo routes (design.md, Interfaces): upload, serve, delete a photo, delete a bet's data. The
 * plugin lives inside the core's scope, so the session guard, the problem+json error handler and
 * `no-store` apply; the upload parser (multipart) is registered here and nowhere else.
 */
export function photoRoutes(options: PhotoRouteOptions): FastifyPluginAsync {
  const { deps } = options;
  return async (app) => {
    await app.register(multipart, {
      // One file, no stray fields: the limits cut a request off before it is buffered whole.
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
      throwFileSizeLimit: true,
    });

    app.post("/api/cards/:id/photo", async (request, reply) => {
      const id = parseBetId(request.params);
      if (!request.isMultipart()) {
        throw unsupportedPhoto();
      }
      options.checkCapacity();
      let bytes: Buffer;
      try {
        const file = await request.file();
        if (file === undefined) {
          throw new HttpError(400, "No photo in the request");
        }
        bytes = await file.toBuffer();
      } catch (error) {
        throw translateUploadError(error);
      }
      const { photo } = await addBeforePhoto(deps, id, bytes);
      return reply.code(201).send(options.afterStored({ cardId: id, photo: photoView(photo) }));
    });

    app.get("/photos/:id", (request, reply) => {
      const { id } = parseParams(photoIdParams, request.params);
      const photo = getPhotoRow(deps.db, id);
      let bytes: Buffer;
      try {
        bytes = deps.photos.read(photo.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new HttpError(404, "Photo not found");
        }
        throw error;
      }
      return reply
        .header("content-type", "image/jpeg")
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .send(bytes);
    });

    app.delete("/api/photos/:id", (request, reply) => {
      const { id } = parseParams(photoIdParams, request.params);
      deletePhoto(deps, id);
      return reply.code(204).send();
    });

    app.delete("/api/bets/:id/data", (request, reply) => {
      deleteBetData(deps, parseBetId(request.params));
      return reply.code(204).send();
    });
  };
}

function translateUploadError(error: unknown): unknown {
  const code = (error as { code?: string }).code;
  if (code === "FST_REQ_FILE_TOO_LARGE") {
    return new HttpError(413, "Photo too large", "Photos can be at most 10 MB.");
  }
  if (typeof code === "string" && code.startsWith("FST_")) {
    return new HttpError(400, "Invalid upload");
  }
  return error;
}
