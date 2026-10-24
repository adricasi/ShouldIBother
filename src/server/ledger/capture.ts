import { isAdviceChore } from "../../domain/advice.js";
import { LAUNDRY_PLAN, isChoreType } from "../../domain/chores.js";
import { MAX_CAPTURE_CHARS, runListener, type ListenerChore } from "../gemma/listener.js";
import { JobQueueFullError } from "../gemma/runner.js";
import { HttpError } from "../problem.js";

import { createChoreCard, createUnbettableCard } from "./cards.js";
import type { LedgerDeps } from "./deps.js";
import { createAdviceCard } from "./advice.js";
import { createPlannerCard } from "./laundry-plan.js";
import { assertGemmaCapacity, gemmaBusy } from "./gemma-cards.js";
import type { CardView } from "./views.js";

export { MAX_CAPTURE_CHARS };

/**
 * Asks the listener for the chores of a sentence; no card is made. Gemma offline or an invalid
 * answer after the retry is an error for the person, never a half-made capture (AC-002.4).
 * Shared by typed capture and by the voice transcript (REQ-027).
 */
export async function listenForChores(
  deps: LedgerDeps,
  text: string,
  source: "typed" | "voice" = "typed",
): Promise<ListenerChore[]> {
  assertGemmaCapacity(deps);
  let result;
  try {
    result = await runListener(deps.gemma, text, source);
  } catch (error) {
    throw error instanceof JobQueueFullError ? gemmaBusy() : error;
  }
  if (!result.ok) {
    if (result.failure === "invalid") {
      throw new HttpError(
        422,
        "Gemma couldn't read that, try rephrasing",
        source === "voice" ? "Try again, or type it." : "Your text is still in the box.",
      );
    }
    throw new HttpError(
      503,
      "Gemma is offline",
      "It could not read that right now. Use a chip below for rule odds, or try again.",
    );
  }
  return result.output.chores;
}

/**
 * One card per chore the listener found. A chore with no weather link is "Not a weather chore"
 * (AC-002.2); one outside this version's list is "Coming later" (AC-002.3); the others go through
 * the same path as a quick chip, so the safety backstop, the offer windows and the rule quote
 * apply. The voice flow calls this only after the person confirmed the transcript (AC-027.1).
 */
export async function cardsFromChores(
  deps: LedgerDeps,
  chores: readonly ListenerChore[],
): Promise<CardView[]> {
  const cards: CardView[] = [];
  for (const chore of chores) {
    if (chore.chore_type === "not_weather") {
      cards.push(createUnbettableCard(deps, "not_weather", chore.chore_type, chore.label));
    } else if (isChoreType(chore.chore_type)) {
      cards.push(await createChoreCard(deps, chore.chore_type, chore.label));
    } else if (chore.chore_type === LAUNDRY_PLAN && deps.flags.laundryPlanner) {
      // REQ-021 (flag `laundryPlanner`): a laundry chore is planned over the next four days.
      cards.push(createPlannerCard(deps, chore.label));
    } else if (isAdviceChore(chore.chore_type) && deps.flags.adviceCards) {
      // REQ-031 (flag `adviceCards`): an outdoor chore gets advice from the advisor, not a bet.
      cards.push(await createAdviceCard(deps, chore.chore_type, chore.label));
    } else {
      cards.push(createUnbettableCard(deps, "coming_later", chore.chore_type, chore.label));
    }
  }
  return cards;
}

/**
 * Typed capture (AC-002.1): the listener finds the chores in a sentence and each becomes a card
 * (`cardsFromChores`). If Gemma is offline or its answer is invalid after the retry, no card is
 * created and the person's text is untouched (AC-002.4).
 */
export async function captureText(deps: LedgerDeps, text: string): Promise<CardView[]> {
  return cardsFromChores(deps, await listenForChores(deps, text));
}
