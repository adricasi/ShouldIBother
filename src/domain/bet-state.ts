/**
 * The bet state machine (design.md, Data model; REQ-006, REQ-008):
 * `open → due → (awaiting_weather) → (awaiting_gemma) → settled`, `open → undone` (undo window)
 * and `open|due → cashed_out` (the flagged cash-out, T-023). The same table is enforced in SQLite
 * by migration 0003, and a test keeps the two equal. The cash-out route only ever moves an `open`
 * bet whose settle time is ahead; the `due → cashed_out` arrow stays because migration 0003's
 * trigger, which cannot change after it was applied, allows it, but no route uses it.
 */
export const BET_STATUSES = [
  "open",
  "due",
  "awaiting_weather",
  "awaiting_gemma",
  "settled",
  "undone",
  "cashed_out",
] as const;

export type BetStatus = (typeof BET_STATUSES)[number];

export const BET_TRANSITIONS: Readonly<Record<BetStatus, readonly BetStatus[]>> = {
  open: ["due", "undone", "cashed_out"],
  due: ["awaiting_weather", "awaiting_gemma", "settled", "cashed_out"],
  awaiting_weather: ["awaiting_gemma", "settled"],
  awaiting_gemma: ["settled"],
  settled: [],
  undone: [],
  cashed_out: [],
};

export function canTransition(from: BetStatus, to: BetStatus): boolean {
  return BET_TRANSITIONS[from].includes(to);
}

/** A bet that is still waiting for its settlement (not settled, undone or cashed out). */
export function isLive(status: BetStatus): boolean {
  return BET_TRANSITIONS[status].length > 0;
}

/** The statuses from which a bet is waiting for its verdict once its settle time has come. */
export const SETTLING_STATUSES: readonly BetStatus[] = [
  "open",
  "due",
  "awaiting_weather",
  "awaiting_gemma",
];

/** AC-006.4: undo is possible up to and including the fifth minute, and only while still open. */
export function canUndo(
  bet: { readonly status: BetStatus; readonly undoUntil: number },
  nowMs: number,
): boolean {
  return bet.status === "open" && nowMs <= bet.undoUntil;
}
