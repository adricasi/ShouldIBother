import { useState } from "react";

import type { Bet } from "./api.js";
import { formatClock, formatPoints } from "./format.js";
import "./rescue.css";

/**
 * The rescue alert and Cash out of a waiting bet (REQ-022, flag `rescue`). Rendered only for a bet
 * the server sent a `rescue` block for, which it does only while the flag is on.
 *
 * - The alert sits in a polite live region that is always in the page, so it is announced when a
 *   later refresh fills it. It is a warning (the forecast moved), not an error.
 * - Cash out costs points, so it takes a second tap: "Yes, cash out" or "Keep the bet".
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
  const [confirming, setConfirming] = useState(false);
  const { rescue } = bet;
  if (rescue === undefined) {
    return null;
  }
  const points = formatPoints(rescue.cash_out_points);
  return (
    <div className="rescue">
      <div role="status" aria-live="polite" className="rescue-live">
        {rescue.alert === null ? null : (
          <p className="notice rescue-alert">
            <span>
              <strong>Rescue alert.</strong> {rescue.alert.text}
            </span>
            <span className="meta">
              Checked {formatClock(rescue.alert.checked_at)}, forecast from{" "}
              {formatClock(rescue.alert.forecast_at)}.
            </span>
          </p>
        )}
      </div>
      {!rescue.can_cash_out ? null : confirming ? (
        <div className="rescue-confirm" role="group" aria-label={`Cash out ${bet.title}?`}>
          <p>Cash out for {points} points? No savings count and the slip closes.</p>
          <button
            type="button"
            className="button primary compact"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              onCashOut(bet.id);
            }}
          >
            Yes, cash out
          </button>
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
            }}
          >
            Keep the bet
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button secondary compact cash-out"
          aria-label={`Cash out (${points} points): ${bet.title}`}
          disabled={busy}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Cash out ({points} points)
        </button>
      )}
    </div>
  );
}
