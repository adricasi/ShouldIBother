import { withGemmaFacts } from "./gemma-facts.js";
import { withSavingsEstimate } from "./savings.js";
import type { LedgerDeps } from "./deps.js";

/**
 * Everything a card view gains from stored facts: the savings estimate (AC-011.7) and, for a card
 * with odds, the rule's band and the Gemma decision behind the quote (AC-028.3, AC-028.4). All of
 * it is read from the database; none of it asks Gemma anything.
 */
export function withCardFacts<
  T extends { readonly quote: { readonly id: number; readonly settle_at: string } | null },
>(
  deps: Pick<LedgerDeps, "db" | "rules" | "now" | "household" | "savings">,
  card: { readonly id: number; readonly chore_type: string },
  view: T,
) {
  return withSavingsEstimate(deps, card, withGemmaFacts(deps, card, view));
}
