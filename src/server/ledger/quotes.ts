import type { Db } from "../db.js";

import type { QuoteRow } from "./rows.js";

export function latestQuote(deps: { readonly db: Db }, cardId: number): QuoteRow | undefined {
  return deps.db
    .prepare<[number], QuoteRow>("SELECT * FROM quotes WHERE card_id = ? ORDER BY id DESC LIMIT 1")
    .get(cardId);
}
