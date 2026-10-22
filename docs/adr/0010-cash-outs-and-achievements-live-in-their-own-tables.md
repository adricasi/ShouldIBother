# 0010. Cash-outs and achievements live in their own tables, not in settlements

- Status: Accepted (2026-10-22)
- Date: 2026-10-22
- Deciders: adricasi

## Context
Rescue and cash-out (T-023, REQ-022) and ranks and achievements (T-026, REQ-025) need to store things that do not fit the settled-bet rows. A cash-out ends a bet at −10 points but has no judge verdict, no evidence and no multiplier. A rescue check is the latest forecast re-check of an open bet. An achievement is a household milestone that must survive the deletion of the bet that earned it (AC-015.2).

`settlements.verdict` has a CHECK list (`win`, the three losses and the two do-it verdicts) and `settlements.evidence` another; widening either in SQLite means rebuilding the `settlements` table (copy, drop, rename, with its indexes and the `appeal_of` self-reference) on a database that may already hold real settled bets. The locked columns of `bets` are protected by the 0003 triggers, so new per-bet state cannot go there. See REQ-009, REQ-020, REQ-022, REQ-025, NFR-003.

## Options considered
1. **Widen `settlements`** (a `cashed_out` verdict, a nullable evidence). Pros: one place for every ending, and the points total keeps a single source. Cons: a table rebuild; every reader of `settlements` (Score, savings, calibration, receipts, appeals) must learn that some rows are not verdicts and filter them.
2. **Columns on `bets`.** Pros: no new tables. Cons: the 0003 triggers lock the table, and a change to them is a migration that replaces the locks; achievements are not per bet anyway.
3. **Their own tables** (`cash_outs`, `rescue_checks`, `achievements`). Pros: only new tables, so existing rows are untouched (NFR-003); settlements keep meaning "a judge verdict"; `cash_outs` and `rescue_checks` cascade with the bet (AC-015.2 needs no extra code), while `achievements` has no link to a bet. Cons: the points total adds more terms (settlements, cash-outs and the advice followed on planner cards), and readers that list endings must look in more than one place.

## Decision
We will use option 3, in migration 0011 (`cash_outs`, `rescue_checks`) and migration 0014 (`achievements`).

- `cash_outs(bet_id, points, cashed_out_at, alert_showing)` holds a cash-out; the bet goes `open → cashed_out`, an arrow migration 0003 already allows, and the row is written in the same transaction.
- `rescue_checks(bet_id, checked_at, forecast_at, rule_band, alert, reason)` holds one row per open bet, replaced by the next check and removed at cash-out. It is derived from the forecast, not household data to keep.
- `achievements(id, unlocked_at)` holds one row per unlocked achievement. `unlocked_at` is the time of the event that met the condition. A row is never deleted by the app, so an appeal or a deletion does not take back an unlock.
- The points total is the sum of final settlements, plus cash-outs, plus the advice followed (AC-009.4). Calibration, the judge overrule rate and the savings read settlements only, so cash-outs stay out of them (AC-020.2). The streak of Sky freeloader reads both tables (AC-025.2).

## Consequences
- Positive: no table rebuild and no data at risk; a verdict row always has a verdict; deleting a bet removes its cash-out and rescue check with it.
- Negative / risks: anything that lists how bets ended must read two tables; a new reader of the points must remember the extra terms. Mitigation: one function (`pointsTotal`) and one ordering helper (`betResults`) hold both, with tests.
- Follow-ups: `sib export` writes `cash_outs` and `achievements` when they have rows.
