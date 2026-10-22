import type { ReactNode } from "react";

const RADIUS = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** How much of the time between placing a bet and its settle time has passed, 0 to 1. */
export function elapsedFraction(placedAtMs: number, settleAtMs: number, nowMs: number): number {
  const span = settleAtMs - placedAtMs;
  if (!(span > 0)) {
    return 1;
  }
  return Math.min(1, Math.max(0, (nowMs - placedAtMs) / span));
}

/** A ring that fills as a bet gets closer to its settle time; its children sit in the middle. */
export function ProgressRing({
  fraction,
  children,
}: {
  readonly fraction: number;
  readonly children: ReactNode;
}) {
  const filled = (fraction * CIRCUMFERENCE).toFixed(2);
  return (
    <span className="ring" aria-hidden="true">
      <svg viewBox="0 0 36 36" focusable="false">
        <circle className="ring-track" cx="18" cy="18" r={RADIUS} />
        <circle
          className="ring-fill"
          cx="18"
          cy="18"
          r={RADIUS}
          strokeDasharray={`${filled} ${CIRCUMFERENCE.toFixed(2)}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className="ring-center">{children}</span>
    </span>
  );
}
