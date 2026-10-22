import { useSyncExternalStore } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** jsdom and very old browsers have no `matchMedia`: then motion is not reduced. */
function reducedMotionQuery(): MediaQueryList | undefined {
  return typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : undefined;
}

function subscribe(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => {
    query?.removeEventListener("change", onChange);
  };
}

/** True while the device asks for reduced motion (WCAG 2.3.3); the stylesheet honours it as well. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => reducedMotionQuery()?.matches ?? false,
    () => false,
  );
}
