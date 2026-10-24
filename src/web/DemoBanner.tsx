import { useEffect, useState } from "react";

import { fetchToday } from "./api.js";
import "./demo-banner.css";

/** The words of the fixed banner in `sib demo` (AC-029.4). */
export const DEMO_BANNER_TEXT = "Sample data — not real results";

/** How often a failed read of the server's demo mode is tried again. */
const RETRY_MS = 15_000;

/**
 * Asks the server once whether it runs `sib demo`. A failed read is tried again, so a laptop that
 * wakes late still shows the banner; an app that is not the demo never shows anything.
 */
function useDemoMode(): boolean {
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      fetchToday().then(
        (today) => {
          if (!cancelled) {
            setDemo(today.demo === true);
          }
        },
        () => {
          if (!cancelled) {
            timer = setTimeout(read, RETRY_MS);
          }
        },
      );
    };
    read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  return demo;
}

/**
 * The persistent "Sample data" banner of `sib demo`, on every screen. It sticks to the top of the
 * page and stays in the flow, so it never covers a heading or a control.
 */
export function DemoBanner() {
  if (!useDemoMode()) {
    return null;
  }
  return (
    <div className="demo-banner" role="region" aria-label="Sample data notice">
      <strong>{DEMO_BANNER_TEXT}</strong>
      <span> · fake model, fake weather, nothing here happened</span>
    </div>
  );
}

/**
 * A "SAMPLE" watermark over figures that look like results (the Score tiles and calibration
 * charts in demo mode). The word is drawn by the stylesheet (`::before`), so it is decoration only:
 * the banner and the label carry the meaning for screen readers, and axe has no text to measure.
 */
export function SampleWatermark() {
  return <span className="sample-watermark" aria-hidden="true" />;
}
