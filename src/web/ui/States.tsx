import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";

/**
 * The loading state of a screen: skeleton blocks and a polite status. It says "Loading" in words,
 * so the state is never only a shimmer (and `prefers-reduced-motion` stops the shimmer).
 */
export function LoadingState({ what }: { readonly what?: string }) {
  return (
    <div className="loading" role="status" aria-busy="true">
      <p className="meta">{what === undefined ? "Loading…" : `Loading ${what}…`}</p>
      <div className="skeleton" aria-hidden="true" />
      <div className="skeleton tall" aria-hidden="true" />
    </div>
  );
}

/** An empty list: an icon and one sentence that says what will appear here. */
export function EmptyState({
  icon,
  children,
}: {
  readonly icon: IconName;
  readonly children: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <p>{children}</p>
    </div>
  );
}

/**
 * The first load failed: what happened in words and a Retry button. The 30 s poll keeps trying
 * on its own, so the screen recovers without a tap too.
 */
export function ErrorState({
  title,
  children,
  busy,
  onRetry,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly busy: boolean;
  readonly onRetry: (() => void) | undefined;
}) {
  return (
    <section className="error-state" aria-labelledby="error-state-title">
      <Icon name="alert" />
      <h2 id="error-state-title" className="section-title">
        {title}
      </h2>
      <p>{children}</p>
      {onRetry === undefined ? null : (
        <button type="button" className="button secondary" disabled={busy} onClick={onRetry}>
          Try again
        </button>
      )}
    </section>
  );
}
