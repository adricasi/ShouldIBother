import type { Bet } from "./api.js";
import { formatPoints } from "./format.js";

/**
 * The rescue alert and the Cash out button of a waiting bet (REQ-022, flag `rescue`). Rendered
 * only for a bet the server sent a `rescue` block for, which it does only while the flag is on.
 * The alert is a status message, not a modal: cashing out is an offer, never an interruption.
 */
export function RescuePanel({
  bet,
  busy,
  onCashOut,
}: {
  bet: Bet;
  busy: boolean;
  onCashOut: (betId: number) => void;
}) {
  const { rescue } = bet;
  if (rescue === undefined) {
    return null;
  }
  return (
    <>
      {rescue.alert === null ? null : (
        <p className="notice error" role="status">
          <strong>Rescue alert.</strong> {rescue.alert.text}
        </p>
      )}
      {rescue.can_cash_out ? (
        <button
          type="button"
          className="button secondary compact"
          disabled={busy}
          onClick={() => {
            onCashOut(bet.id);
          }}
        >
          Cash out ({formatPoints(rescue.cash_out_points)} points)
        </button>
      ) : null}
    </>
  );
}
