# 0009. Cards without odds are `coming_later` cards with a notice

- Status: Accepted (2026-10-22)
- Date: 2026-10-22
- Deciders: adricasi

## Context
Some cards have no odds and no bet action, and each says why in its own words: no forecast younger than 24 h (AC-014.4), AC or heater not used this season (AC-016.5), line-dry outside its offer window (AC-016.4), and a chore that is not offered yet (AC-002.3). T-005 had to store them. `cards.kind` carries a CHECK constraint (`weather`, `not_weather`, `coming_later`, `alert`); changing it in SQLite means rebuilding the `cards` table, and dropping `cards` cascade-deletes its bets, quotes and photos. See REQ-014, REQ-016, NFR-003.

## Options considered
1. **A new card kind per case** (`no_forecast`, `not_needed`, `outside_window`). Pros: the kind says why. Cons: a table rebuild with cascade deletes on a database that may already hold real bets; every client switch grows.
2. **Reject the request** (503 for no forecast, 409 for the rest) and create no card. Pros: no new data. Cons: the person sees an error where a card with an explanation is wanted; the AC says the card shows the words.
3. **Reuse `coming_later` and add a nullable `cards.notice`** (migration 0004). Pros: one `ALTER TABLE ADD COLUMN`, existing rows untouched; the card exists, so Today shows it and it can leave Today on its own. Cons: the kind alone no longer says why, so clients must read `notice`.

## Decision
We will use option 3. A card with no odds and no bet action is stored with `kind = 'coming_later'` and, when it has a reason of its own, a `notice`: "No forecast, can't set odds", "Not needed this season", or the offer-window text ("Line-dry today (skip the dryer) is offered from 07:00 to 15:00. Next chance: today at 07:00."). A `coming_later` card without a notice reads "Coming later" (AC-002.3). The request that makes such a card succeeds with 201; AC-014.4 is therefore a card with a notice, not a 503. Clients key on `notice`, not on the kind, which only says "no odds, no bet action".

Rules that go with it:
- Order of checks when a chore card is created: not needed this season, not offered yet, outside the offer window, no forecast, safety alert, rule quote.
- AC and heater are "Not needed this season" when `config/household.json` says so (`airConditioning`, `heaterThisSeason`). The one `heater` flag in `config/flags.json` gates both seasonal chores: until it is on, a chore the household does use reads "Coming later".
- The line-dry offer window is [07:00, 15:00) Europe/Madrid: 07:00 is in, 15:00 is out.
- Tapping a chip again for the same quiet card within 30 minutes shows the card that is already there; quiet cards leave Today after 12 hours.
- `SIB_FAKE_WEATHER=1` swaps in fake weather for development; the live app otherwise uses Open-Meteo.

## Consequences
- Positive: no table rebuild, no data at risk; the card is visible and explains itself; one code path for "no odds".
- Negative / risks: the `kind` column is less specific than the card's meaning; a client that switches on the kind alone shows "Coming later" for a no-forecast card. Mitigation: the API view always carries the words in `notice` (a `coming_later` card with no stored notice reads "Coming later") and the web client renders that text.
- Follow-ups: T-013 turns on the "Leave it out tonight" offer window behind its own flag; until then that chore reads "Coming later".
