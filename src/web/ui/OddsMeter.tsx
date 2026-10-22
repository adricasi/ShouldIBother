import { Icon } from "./Icon.js";

/**
 * "Chance doing nothing works": the odds before → after the photo as a bar (bet sheet, AC-005.3).
 * The bar repeats what the words say, so it is hidden from screen readers.
 */
export function OddsMeter({
  before,
  after,
  text,
}: {
  readonly before: number;
  readonly after: number;
  readonly text: string;
}) {
  return (
    <div className="odds-meter">
      <p className="odds-meter-head">
        <span className="odds-meter-title">Chance doing nothing works</span>
        <span className="odds-meter-figures" aria-hidden="true">
          <span className="odds-before">{before}%</span>
          <span className="odds-arrow">
            <Icon name="arrow" />
          </span>
          <span className="odds-after">{after}%</span>
        </span>
      </p>
      <span className="odds-bar" aria-hidden="true">
        <span className="odds-bar-fill" style={{ width: `${after}%` }} />
      </span>
      <p className="odds-change">With the photo: {text}</p>
    </div>
  );
}
