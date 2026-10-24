import type { Advice, Card } from "./api.js";
import { HowGemmaDecided } from "./GemmaParts.js";
import { formatWindow } from "./format.js";
import { ChoreTile } from "./ui/ChoreTile.js";
import { Icon } from "./ui/Icon.js";

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
      <summary>
        <Icon name="rain" /> Forecast for this window ({advice.forecast.length} h)
      </summary>
      <div
        className="advice-forecast-scroll"
        tabIndex={0}
        role="region"
        aria-label="Forecast for this window, scrollable"
      >
        <table className="decision-forecast">
          <caption className="meta">The forecast the tool returned to Gemma</caption>
          <thead>
            <tr>
              <th scope="col">Hour</th>
              <th scope="col">Rain mm</th>
              <th scope="col">Rain chance %</th>
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
      </div>
      {advice.forecast.length < advice.forecast_total ? (
        <p className="meta">
          Forecast shown: {advice.forecast.length} of {advice.forecast_total} hours
        </p>
      ) : null}
    </details>
  );
}

/** What the live region says: one sentence for the state the card is in. */
function statusText(advice: Advice): string {
  if (advice.stage === "unavailable") {
    return advice.note ?? "No advice yet.";
  }
  if (advice.stage === "thinking") {
    return advice.note ?? "Gemma is checking the forecast.";
  }
  if (advice.source === "rule") {
    return advice.can_retry
      ? "Showing the rule advice, because Gemma has none."
      : "Gemma is thinking, showing rule advice.";
  }
  return `Gemma's advice is in: ${advice.headline ?? ""}`;
}

/**
 * An advice card (REQ-031): advice, not a bet. It shows whose advice it is, then the advice and its
 * reason, with the window in Madrid time (AC-031.1); the rule's advice beside Gemma's when they
 * differ and labelled "Rule advice" when Gemma has none (AC-031.2); the forecast numbers of the
 * window; Retry; and the "How Gemma decided" disclosure (AC-031.3).
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
  const asWindow = advice.advice === "wait" && advice.window !== null;
  return (
    <article
      className="slip flat advice"
      aria-label={advice.headline === null ? card.title : `${card.title}, ${advice.headline}`}
    >
      <div className="slip-top">
        <p className="eyebrow">Lazy Bookie · Advice</p>
        <p className="eyebrow advice-tag">No bet</p>
      </div>
      <hr className="rule" />
      <div className="slip-head">
        <ChoreTile title={card.title} choreType={card.chore_type} />
        <div className="line-main">
          {advice.label === null ? null : (
            <p className={`advice-label ${advice.source ?? ""}`}>{advice.label}</p>
          )}
          {advice.note !== null && advice.stage === "advice" ? (
            <p className="meta advice-note">{advice.note}</p>
          ) : null}
          <h3 className={advice.source === "rule" ? "advice-quiet" : undefined}>{heading}</h3>
        </div>
      </div>
      <p role="status" className="meta advice-status">
        {statusText(advice)}
      </p>
      {advice.reason === null ? null : <p>{advice.reason}</p>}
      {asWindow && advice.window !== null ? (
        <p className="meta">{formatWindow(advice.window.from, advice.window.to)} (Madrid time)</p>
      ) : null}
      {advice.rule === null ? null : (
        <div className="bands-compare advice-rule">
          <span className="advice-label rule">Rule advice</span>
          <strong>{advice.rule.headline ?? "No rule advice for this window"}</strong>
          <span className="meta">{advice.rule.reason}</span>
        </div>
      )}
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
    </article>
  );
}
