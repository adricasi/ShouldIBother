import type { Advice, Card } from "./api.js";
import { HowGemmaDecided } from "./GemmaParts.js";
import { formatSettleTime } from "./format.js";
import { ChoreTile } from "./ui/ChoreTile.js";

function cell(value: number | null): string {
  return value === null ? "–" : String(value);
}

/** The forecast numbers Gemma was given for the window: the stored tool result, hour by hour. */
function WindowForecast({ advice }: { advice: Advice }) {
  if (advice.forecast.length === 0) {
    return null;
  }
  return (
    <details className="how-gemma advice-forecast">
      <summary>Forecast for this window ({advice.forecast.length} h)</summary>
      <table className="decision-forecast">
        <caption className="meta">The forecast the tool returned to Gemma</caption>
        <thead>
          <tr>
            <th scope="col">Hour</th>
            <th scope="col">Rain mm</th>
            <th scope="col">Rain %</th>
            <th scope="col">°C</th>
            <th scope="col">Wind km/h</th>
          </tr>
        </thead>
        <tbody>
          {advice.forecast.map((row) => (
            <tr key={row.hour}>
              <th scope="row">{row.hour}</th>
              <td>{cell(row.rain_mm)}</td>
              <td>{cell(row.rain_prob_pct)}</td>
              <td>{cell(row.temp_c)}</td>
              <td>{cell(row.wind_kmh)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * An advice card (REQ-031): advice, not a bet. It shows Gemma's advice and window in Madrid time
 * with its reason, or the rule's advice labelled as such (AC-031.2); the rule's beside Gemma's when
 * they differ; the forecast numbers of the window; Retry when Gemma has no advice; and the "How
 * Gemma decided" disclosure (AC-031.3).
 */
export function AdviceSlip({
  card,
  advice,
  busy,
  onRetry,
}: {
  card: Card;
  advice: Advice;
  busy: boolean;
  onRetry: (cardId: number) => void;
}) {
  const heading = advice.headline ?? card.title;
  return (
    <article className="slip flat advice" aria-label={`${card.title}, ${heading}`}>
      <div className="slip-top">
        <p className="eyebrow">Lazy Bookie · Advice</p>
        <p className="eyebrow advice-tag">No bet</p>
      </div>
      <hr className="rule" />
      <div className="slip-head">
        <ChoreTile title={card.title} choreType={card.chore_type} />
        <div className="line-main">
          <h3>{heading}</h3>
          {advice.label === null ? null : (
            <p className={`advice-label ${advice.source ?? ""}`}>{advice.label}</p>
          )}
        </div>
      </div>
      {advice.stage === "thinking" || advice.stage === "unavailable" ? (
        <p role="status">{advice.note ?? "Gemma is checking the forecast."}</p>
      ) : null}
      {advice.reason === null ? null : <p>{advice.reason}</p>}
      {advice.window === null ? null : (
        <p className="meta">
          Window: {formatSettleTime(advice.window.from)} to {formatSettleTime(advice.window.to)}{" "}
          (Madrid time)
        </p>
      )}
      {advice.rule === null ? null : (
        <div className="bands-compare advice-rule">
          <strong>Rule advice: {advice.rule.headline ?? "none"}</strong>
          <span className="meta"> {advice.rule.reason}</span>
        </div>
      )}
      {advice.note !== null && advice.stage === "advice" ? (
        <p className="meta" role="status">
          {advice.note}
        </p>
      ) : null}
      <WindowForecast advice={advice} />
      {advice.can_retry ? (
        <button
          type="button"
          className="button secondary compact"
          disabled={busy}
          onClick={() => {
            onRetry(card.id);
          }}
        >
          Retry Gemma
        </button>
      ) : null}
      <HowGemmaDecided decisions={[{ decision: advice.decision }]} />
      <p className="meta">This is advice, not a bet.</p>
    </article>
  );
}
