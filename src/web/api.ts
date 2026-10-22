import { z } from "zod";

import { flagsSchema } from "./features.js";

const payoutsSchema = z.object({
  win_with_photo: z.number(),
  win_with_tap: z.number(),
  small_loss: z.number(),
  normal_loss: z.number(),
  harmful_loss: z.number(),
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
  payouts: payoutsSchema,
});

export const cardSchema = z.object({
  id: z.number(),
  chore_type: z.string(),
  title: z.string(),
  created_at: z.string(),
  quote: quoteSchema,
});

export const betSchema = z.object({
  id: z.number(),
  card_id: z.number(),
  title: z.string(),
  band: z.number(),
  band_name: z.string(),
  odds: z.number(),
  odds_source: z.enum(["rule", "gemma"]),
  reason: z.string(),
  settle_at: z.string(),
  status: z.string(),
  payouts: payoutsSchema,
  tap_answers: z.array(z.object({ id: z.string(), label: z.string() })),
});

export const todaySchema = z.object({
  now: z.string(),
  flags: flagsSchema,
  points: z.object({ total: z.number() }),
  cards: z.array(cardSchema),
  open_bets: z.array(betSchema),
  due_bets: z.array(betSchema),
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
export type Bet = z.infer<typeof betSchema>;
export type Today = z.infer<typeof todaySchema>;
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
  init?: { method: "POST"; body: unknown },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...(init === undefined
        ? {}
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
  return schema.parse(await response.json());
}

export const fetchToday = (): Promise<Today> => request("/api/today", todaySchema);

export const createQuickCard = (choreType: string): Promise<Card> =>
  request("/api/cards/quick", cardSchema, {
    method: "POST",
    body: { chore_type: choreType },
  });

/** `quoteId` is the quote the user is looking at; the server refuses if the card moved on. */
export const placeBet = (cardId: number, quoteId: number): Promise<Bet> =>
  request("/api/bets", betSchema, {
    method: "POST",
    body: { card_id: cardId, quote_id: quoteId, kind: "do_nothing" },
  });

export const settleBet = (betId: number, answer: string): Promise<Settled> =>
  request(`/api/bets/${betId}/settle`, settledSchema, { method: "POST", body: { answer } });
