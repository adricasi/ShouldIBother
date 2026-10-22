import { z } from "zod";

import { flagsSchema } from "./features.js";

const payoutsSchema = z.object({
  win_with_photo: z.number(),
  win_with_tap: z.number(),
  small_loss: z.number(),
  normal_loss: z.number(),
  harmful_loss: z.number(),
  do_it_if_not_needed: z.number(),
  do_it_if_needed: z.number(),
});

const quoteSchema = z.object({
  id: z.number(),
  source: z.enum(["rule", "gemma"]),
  band: z.number(),
  band_name: z.string(),
  odds: z.number(),
  reason: z.string(),
  settle_at: z.string(),
  label: z.string(),
  provisional: z.boolean(),
  /** True when the odds were set with the card's photo (AC-005.3). */
  with_photo: z.boolean().optional(),
  payouts: payoutsSchema,
});

/** The card's before photo, with What Gemma saw and the odds before → after (REQ-005). */
export const photoSchema = z.object({
  id: z.string(),
  url: z.string(),
  state: z.enum(["inspecting", "seen", "unsure", "failed"]),
  /** "What Gemma saw" (AC-005.3). */
  saw: z.array(z.object({ name: z.string(), label: z.string(), value: z.string() })),
  /** Gemma's yes/no question when it could not tell from the photo (AC-005.4). */
  question: z.string().nullable(),
  note: z.string().nullable(),
  odds_change: z
    .object({
      before: z.number(),
      after: z.number(),
      before_band_name: z.string(),
      after_band_name: z.string(),
      text: z.string(),
    })
    .nullable(),
});

export const cardSchema = z.object({
  id: z.number(),
  chore_type: z.string(),
  title: z.string(),
  created_at: z.string(),
  kind: z.enum(["weather", "not_weather", "coming_later", "alert"]),
  /** Set on a "Do it now" alert; the card has no odds and no bet action (AC-012.1). */
  alert_reason: z.string().nullable(),
  /** Set on a card without odds that says why (AC-014.4, AC-016.4, AC-016.5). */
  notice: z.string().nullable(),
  /** Null on every card that cannot be bet on. */
  quote: quoteSchema.nullable(),
  /** Where the card stands with Gemma; null on a card that gets no Gemma quote (REQ-013). */
  gemma: z
    .object({
      state: z.enum(["thinking", "answered", "question", "offline"]),
      /** Gemma's yes/no question, answered with two taps (AC-003.3). */
      question: z.string().nullable(),
      /** Why Gemma has no answer, in plain words. */
      note: z.string().nullable(),
      can_retry: z.boolean(),
    })
    .nullable(),
  photo: photoSchema.nullish(),
});

export const betSchema = z.object({
  id: z.number(),
  card_id: z.number(),
  title: z.string(),
  kind: z.enum(["do_nothing", "do_it"]),
  band: z.number(),
  band_name: z.string(),
  odds: z.number(),
  odds_source: z.enum(["rule", "gemma"]),
  reason: z.string(),
  placed_at: z.string(),
  undo_until: z.string(),
  undoable: z.boolean(),
  settle_at: z.string(),
  status: z.string(),
  payouts: payoutsSchema,
  tap_answers: z.array(z.object({ id: z.string(), label: z.string() })),
});

export const todaySchema = z.object({
  now: z.string(),
  flags: flagsSchema,
  points: z.object({ total: z.number() }),
  /** Gemma's status, refreshed at least every 60 s (AC-013.5). */
  gemma: z.object({
    status: z.enum(["online", "waking", "offline"]),
    detail: z.string().nullable(),
    checked_at: z.string(),
  }),
  /** The forecast behind the odds: when it was fetched and how old that is (AC-014.3). */
  forecast: z
    .object({ fetched_at: z.string(), age_label: z.string(), stale: z.boolean() })
    .nullable(),
  /** Open-Meteo attribution, shown in the app (AC-014.6). */
  attribution: z.string(),
  cards: z.array(cardSchema),
  open_bets: z.array(betSchema),
  due_bets: z.array(betSchema),
});

export const slipsSchema = z.object({
  now: z.string(),
  settle_now: z.array(betSchema),
  waiting: z.array(betSchema.extend({ time_left_ms: z.number() })),
  settled: z.array(
    betSchema.extend({
      result: z.object({
        verdict: z.string(),
        points: z.number(),
        evidence: z.string(),
        settled_at: z.string(),
      }),
    }),
  ),
});

export const settledSchema = z.object({
  bet_id: z.number(),
  verdict: z.string(),
  reason: z.string(),
  evidence: z.array(z.string()),
  multiplier: z.number(),
  points: z.number(),
  total_points: z.number(),
});

export type Card = z.infer<typeof cardSchema>;
export type CardPhoto = z.infer<typeof photoSchema>;
export type Bet = z.infer<typeof betSchema>;
export type Today = z.infer<typeof todaySchema>;
export type Slips = z.infer<typeof slipsSchema>;
export type BetKind = Bet["kind"];
export type Settled = z.infer<typeof settledSchema>;

/** A failed request: the server's RFC 9457 title and detail, or a plain network message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const problemSchema = z.object({ title: z.string(), detail: z.string().optional() });

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?:
    { method: "POST"; body: unknown } | { method: "POST"; form: FormData } | { method: "DELETE" },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...(init === undefined
        ? {}
        : init.method === "DELETE"
          ? { method: "DELETE" }
          : "form" in init
            ? // The browser sets the multipart boundary itself.
              { method: "POST", body: init.form }
            : {
                method: init.method,
                headers: { "content-type": "application/json" },
                body: JSON.stringify(init.body),
              }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the laptop. Check the Wi-Fi and try again.");
  }
  if (response.status === 401) {
    throw new ApiError(
      401,
      "This device is not paired. Open the pairing link shown on the laptop.",
    );
  }
  if (!response.ok) {
    const problem = problemSchema.safeParse(await response.json().catch(() => undefined));
    const text = problem.success
      ? [problem.data.title, problem.data.detail].filter(Boolean).join(": ")
      : `The laptop answered ${response.status}.`;
    throw new ApiError(response.status, text);
  }
  if (response.status === 204) {
    return schema.parse(undefined);
  }
  return schema.parse(await response.json());
}

export const fetchToday = (): Promise<Today> => request("/api/today", todaySchema);

export const createQuickCard = (choreType: string): Promise<Card> =>
  request("/api/cards/quick", cardSchema, {
    method: "POST",
    body: { chore_type: choreType },
  });

/** Typed capture: the listener turns a sentence into one card per chore (AC-002.1). */
export const captureCards = (text: string): Promise<Card[]> =>
  request("/api/cards", z.object({ cards: z.array(cardSchema) }), {
    method: "POST",
    body: { text },
  }).then((result) => result.cards);

/** Retry after "Gemma offline · rule odds" (AC-013.3). */
export const retryCard = (cardId: number): Promise<Card> =>
  request(`/api/cards/${cardId}/retry`, cardSchema, { method: "POST", body: {} });

/** The tap on Gemma's yes/no question (AC-003.3). */
export const answerCard = (cardId: number, yes: boolean): Promise<Card> =>
  request(`/api/cards/${cardId}/answer`, cardSchema, { method: "POST", body: { yes } });

/** Sends a before photo; Gemma then looks at it and the card is polled (AC-005.2). */
export const uploadPhoto = (cardId: number, file: File): Promise<Card> => {
  const form = new FormData();
  form.append("photo", file);
  return request(`/api/cards/${cardId}/photo`, z.object({ card: cardSchema }), {
    method: "POST",
    form,
  }).then((result) => result.card);
};

/** Deletes a photo and what was derived from it (AC-015.2). */
export const deletePhoto = (photoId: string): Promise<undefined> =>
  request(`/api/photos/${photoId}`, z.undefined(), { method: "DELETE" });

export const fetchSlips = (): Promise<Slips> => request("/api/slips", slipsSchema);

/** `quoteId` is the quote the user is looking at; the server refuses if the card moved on. */
export const placeBet = (
  cardId: number,
  quoteId: number,
  kind: BetKind = "do_nothing",
): Promise<Bet> =>
  request("/api/bets", betSchema, {
    method: "POST",
    body: { card_id: cardId, quote_id: quoteId, kind },
  });

export const undoBet = (betId: number): Promise<Bet> =>
  request(`/api/bets/${betId}`, betSchema, { method: "DELETE" });

export const settleBet = (betId: number, answer: string): Promise<Settled> =>
  request(`/api/bets/${betId}/settle`, settledSchema, { method: "POST", body: { answer } });
