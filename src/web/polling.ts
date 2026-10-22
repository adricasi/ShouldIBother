/** The part of `document` the poller needs; a test passes a fake. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Design and AC-007.2: Today and Slips refresh at least every 30 s while the page is visible. */
export const POLL_INTERVAL_MS = 30_000;

/**
 * Calls `refresh` right away, then every `intervalMs` while the page is visible (Page Visibility
 * API). A hidden page makes no requests; when it becomes visible again the data is refreshed at
 * once instead of waiting for the next tick. Returns the function that stops it.
 */
export function startPolling(
  refresh: () => void,
  source: VisibilitySource = document,
  intervalMs: number = POLL_INTERVAL_MS,
): () => void {
  const isVisible = (): boolean => source.visibilityState === "visible";
  const onVisibilityChange = (): void => {
    if (isVisible()) {
      refresh();
    }
  };
  if (isVisible()) {
    refresh();
  }
  const timer = setInterval(() => {
    if (isVisible()) {
      refresh();
    }
  }, intervalMs);
  source.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearInterval(timer);
    source.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/** The server's clock estimated from its last answer, so countdowns need no extra requests. */
export function estimateServerNow(
  base: { readonly serverMs: number; readonly localMs: number },
  localNowMs: number,
): number {
  return base.serverMs + (localNowMs - base.localMs);
}
