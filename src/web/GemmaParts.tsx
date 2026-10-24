import type { BandFact, Decision } from "./api.js";
import { Icon } from "./ui/Icon.js";
import "./gemma.css";

/** What a short "Gemma: likely 70%" reads for a band: its words and its odds (AC-003.5). */
function bandText(band: BandFact): string {
  return `${band.band_name} ${band.odds}%`;
}

/**
 * Whose odds these are (AC-028.3): "Gemma's odds" or "Rule odds", from `odds_source`. When Gemma's
 * band differs from the rule's, both are shown side by side. Gemma's reason is the reason the
 * slip already prints; this line is the one that says the two disagree.
 */
export function OddsWho({
  source,
  gemma,
  rule,
}: {
  readonly source: "rule" | "gemma" | undefined;
  readonly gemma: BandFact | null | undefined;
  readonly rule: BandFact | undefined;
}) {
  if (source === undefined) {
    return null;
  }
  const differs =
    source === "gemma" && gemma != null && rule !== undefined && gemma.band !== rule.band;
  return (
    <span className="odds-who">
      <span className="odds-owner">{source === "gemma" ? "Gemma's odds" : "Rule odds"}</span>
      {differs ? (
        <span className="odds-compare">
          {" "}
          · Gemma: {bandText(gemma)} · Rule: {bandText(rule)}
        </span>
      ) : null}
    </span>
  );
}

/** The two bands side by side, as a line of its own on a slip (AC-028.3); null when they agree. */
export function BandsSideBySide({
  gemma,
  rule,
}: {
  readonly gemma: BandFact;
  readonly rule: BandFact | undefined;
}) {
  if (rule === undefined || rule.band === gemma.band) {
    return null;
  }
  return (
    <p className="bands-compare">
      <strong>Gemma: {bandText(gemma)}</strong> · Rule: {bandText(rule)}
    </p>
  );
}

const TOOL_MODE_TEXT = {
  called: "Gemma called get_forecast",
  injected: "Forecast injected: the app fetched it for Gemma",
  missed: "Gemma missed the forecast tool → retry",
} as const;

/** The model tag, said honestly: the fixture model is not Gemma (AC-028.4). */
function modelText(decision: Decision): string {
  return decision.fake
    ? `${decision.model} (fake model: recorded test answers, not Gemma)`
    : decision.model;
}

/** One decision as rows: the facts of AC-028.4 and the forecast hours the tool returned. */
function DecisionFacts({
  decision,
  heading,
}: {
  decision: Decision;
  heading?: string | undefined;
}) {
  return (
    <div className="decision">
      {heading === undefined ? null : <p className="eyebrow">{heading}</p>}
      <dl className="decision-facts">
        <div>
          <dt>Model</dt>
          <dd>{modelText(decision)}</dd>
        </div>
        {decision.digest === null ? null : (
          <div>
            <dt>Digest</dt>
            <dd className="mono-text">{decision.digest}</dd>
          </div>
        )}
        <div>
          <dt>Prompt</dt>
          <dd className="mono-text">{decision.prompt_version}</dd>
        </div>
        <div>
          <dt>Forecast tool</dt>
          <dd>
            {decision.tool_mode === null
              ? "Not used by this job"
              : TOOL_MODE_TEXT[decision.tool_mode]}
          </dd>
        </div>
        <div>
          <dt>Retries</dt>
          <dd>{decision.retries}</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>{formatLatency(decision.latency_ms)}</dd>
        </div>
      </dl>
      {decision.forecast === null || decision.forecast.length === 0 ? null : (
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
            {decision.forecast.map((row) => (
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
      )}
    </div>
  );
}

function cell(value: number | null): string {
  return value === null ? "–" : String(value);
}

/** "0.9 s" or "820 ms": a latency in the words a person reads. */
export function formatLatency(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${ms} ms`;
}

/**
 * "How Gemma decided" (AC-028.4): a native disclosure with what is stored about the decision.
 * Nothing in it is sent anywhere. Renders nothing without a decision (a bet on rule odds, or a
 * decision whose row was deleted).
 */
export function HowGemmaDecided({
  decisions,
}: {
  readonly decisions: readonly {
    readonly heading?: string;
    readonly decision: Decision | null | undefined;
  }[];
}) {
  const shown = decisions.flatMap((entry) =>
    entry.decision == null ? [] : [{ heading: entry.heading, decision: entry.decision }],
  );
  if (shown.length === 0) {
    return null;
  }
  return (
    <details className="how-gemma">
      <summary>
        <Icon name="sparkle" /> How Gemma decided
      </summary>
      {shown.map((entry) => (
        <DecisionFacts
          key={entry.heading ?? entry.decision.job}
          decision={entry.decision}
          heading={entry.heading}
        />
      ))}
    </details>
  );
}
