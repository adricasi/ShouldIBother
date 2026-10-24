import "./demo-banner.css";

/** The words of the fixed banner in `sib demo` (AC-029.4). */
export const DEMO_BANNER_TEXT = "Sample data — not real results";

/**
 * The persistent "Sample data" banner of `sib demo`, on every screen; App shows it when the server's
 * Today answer says `demo` (no request of its own). It sticks to the top of the
 * page and stays in the flow, so it never covers a heading or a control.
 */
export function DemoBanner() {
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
