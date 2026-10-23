import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import { LAUNDRY_PLAN, isChoreType } from "../../domain/chores.js";
import { runListenerAudio } from "../gemma/listener-audio.js";
import { listenerOutputSchema, type ListenerChore } from "../gemma/listener.js";
import { JobQueueFullError } from "../gemma/runner.js";
import { assertGemmaCapacity, gemmaBusy } from "../ledger/gemma-cards.js";
import { cardsFromChores, listenForChores } from "../ledger/capture.js";
import type { LedgerDeps } from "../ledger/deps.js";
import { HttpError } from "../problem.js";

import { MAX_VOICE_BYTES, inspectWav } from "./wav.js";

/**
 * How the person sees a chore of the transcript: `weather` gets odds (highlighted green),
 * `coming_later` is a weather chore this version cannot bet on yet (also highlighted, "No bet
 * yet"), `not_weather` is not a weather chore (grey), as in mockup 03.
 */
export type VoiceChoreKind = "weather" | "coming_later" | "not_weather";

export interface VoiceChore extends ListenerChore {
  readonly kind: VoiceChoreKind;
}

export interface VoicePreview {
  /** What Gemma heard. Household text: it goes back to the phone and is stored nowhere. */
  readonly transcript: string;
  readonly chores: readonly VoiceChore[];
  readonly duration_ms: number;
}

/** The audio job and the listener on its transcript. */
const VOICE_JOBS = 2;

const confirmBody = z.object({ chores: listenerOutputSchema.shape.chores }).strict();

function kindOf(deps: Pick<LedgerDeps, "flags">, chore: ListenerChore): VoiceChoreKind {
  if (chore.chore_type === "not_weather") {
    return "not_weather";
  }
  const bettable =
    isChoreType(chore.chore_type) ||
    (chore.chore_type === LAUNDRY_PLAN && deps.flags.laundryPlanner);
  return bettable ? "weather" : "coming_later";
}

/** The bytes of the one uploaded voice note; upload errors become problems (413, 400, 415). */
async function readVoiceNote(request: FastifyRequest): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? "0");
  // The multipart framing adds a few hundred bytes around the file.
  if (declared > MAX_VOICE_BYTES + 4096) {
    throw tooLarge();
  }
  try {
    const file = await request.file({
      limits: { fileSize: MAX_VOICE_BYTES, files: 1, fields: 0, parts: 1 },
    });
    if (file === undefined) {
      throw new HttpError(400, "No voice note in the request");
    }
    return await file.toBuffer();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") {
      throw tooLarge();
    }
    if (typeof code === "string" && code.startsWith("FST_")) {
      throw new HttpError(400, "Invalid upload");
    }
    throw error;
  }
}

function tooLarge(): HttpError {
  return new HttpError(413, "Voice note too large", "Keep it to a sentence or two.");
}

/**
 * The first step of a voice capture (AC-027.1): Gemma 4 audio writes down the note and the
 * listener finds the chores in the transcript. No card is made; the phone shows the transcript
 * with the chores highlighted and the person confirms first. The audio stays in memory, goes
 * only to the model runtime on this laptop (AC-027.2) and is dropped when the request ends.
 */
export async function previewVoiceNote(deps: LedgerDeps, audio: Buffer): Promise<VoicePreview> {
  const wav = inspectWav(audio);
  let heard;
  try {
    // The model gets the canonical copy, which holds exactly the samples that were measured.
    heard = await runListenerAudio(deps.gemma, wav.audio, {
      bytes: wav.audio.length,
      durationMs: wav.durationMs,
    });
  } catch (error) {
    throw error instanceof JobQueueFullError ? gemmaBusy() : error;
  }
  if (!heard.ok) {
    if (heard.failure === "invalid") {
      throw new HttpError(
        422,
        "Gemma couldn't make that out",
        "Try again a bit closer to the phone, or type it.",
      );
    }
    throw new HttpError(
      503,
      "Voice is offline",
      "The audio model on the laptop is not answering. Type your chores instead, or try again.",
    );
  }
  if (heard.output.status === "unsure") {
    throw new HttpError(
      422,
      "Gemma couldn't make that out",
      "Try again a bit closer to the phone, or type it.",
    );
  }
  const chores = await listenForChores(deps, heard.output.transcript, "voice");
  return {
    transcript: heard.output.transcript,
    chores: chores.map((chore) => ({ ...chore, kind: kindOf(deps, chore) })),
    duration_ms: wav.durationMs,
  };
}

/**
 * Voice routes (flag `voice`, REQ-027). The plugin lives inside the core's scope, so the session
 * guard, the problem+json error handler, `no-store` and the multipart parser apply; with the flag
 * off the core does not register it and both paths are a plain 404 (AC-029.2).
 */
export function voiceRoutes(deps: LedgerDeps): FastifyPluginAsync {
  return (app) => {
    app.post("/api/voice/transcript", async (request, reply) => {
      if (!request.isMultipart()) {
        throw new HttpError(415, "Send the voice note as a multipart upload");
      }
      // Two jobs run back to back (the note, then its transcript): refuse before the upload is
      // read rather than after the audio job ran.
      assertGemmaCapacity(deps, VOICE_JOBS);
      return reply.send(await previewVoiceNote(deps, await readVoiceNote(request)));
    });

    // The person confirmed the highlighted chores: now, and only now, the cards are made.
    app.post("/api/voice/cards", async (request, reply) => {
      const parsed = confirmBody.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(400, "Invalid request", "Send the confirmed chores.");
      }
      assertGemmaCapacity(deps);
      return reply.code(201).send({ cards: await cardsFromChores(deps, parsed.data.chores) });
    });
    return Promise.resolve();
  };
}
