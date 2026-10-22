import type { Receipt, RecordedWeather, SavingsTotals } from "./api.js";
import {
  formatDuration,
  formatKwh,
  formatLitres,
  formatNetDuration,
  formatOdds,
  formatPoints,
  formatSettleTime,
} from "./format.js";

type Digest = RecordedWeather["digest"];

/** The recorded weather as short chips: rain, temperature, wind, sun (AC-008.1). */
export function weatherChips(digest: Digest): string[] {
  const chips: string[] = [];
  if (digest.rain_mm !== null) {
    const wet = digest.wet_hours === null ? "" : `, ${digest.wet_hours} wet h`;
    chips.push(`Rain ${digest.rain_mm} mm${wet}`);
  }
  if (digest.temp_min_c !== null && digest.temp_max_c !== null) {
    chips.push(`${digest.temp_min_c} to ${digest.temp_max_c} °C`);
  }
  if (digest.wind_max_kmh !== null) {
    chips.push(`Wind up to ${digest.wind_max_kmh} km/h`);
  }
  if (digest.sunshine_h !== null) {
    chips.push(`Sun ${digest.sunshine_h} h`);
  }
  return chips;
}

/** "Modelled recent weather" with its numbers; says so when they are not in yet. */
export function WeatherLine({ weather }: { weather: { label: string; digest: Digest } | null }) {
  if (weather === null) {
    return <p className="meta">The recorded weather is not in yet.</p>;
  }
  return (
    <div className="weather-record">
      <p className="eyebrow">{weather.label}</p>
      <ul className="chips-static" aria-label="Recorded weather">
        {weatherChips(weather.digest).map((chip) => (
          <li key={chip}>{chip}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The result of a settled bet. A win prints the PAID OUT receipt with a static stamp (AC-010.1;
 * the stamp animation is T-017); a loss or a do-it result shows the points, Gemma's reason and the
 * fixed copy, with no stamp (AC-010.2). "Gemma's read" lists its reason and the numbers it used
 * (AC-028.1).
 */
export function ReceiptCard({ receipt }: { receipt: Receipt }) {
  const paid = receipt.outcome === "paid_out";
  return (
    <article
      className={`receipt ${paid ? "paid" : "plain"}`}
      aria-label={`${receipt.title}, ${receipt.verdict_title}, ${formatPoints(receipt.points)} points`}
    >
      <p className="eyebrow">Lazy Bookie · {paid ? "Payout receipt" : "Result"}</p>
      <div className="receipt-head">
        <h3>{receipt.title}</h3>
        {receipt.stamp === null ? null : <p className="stamp">{receipt.stamp}</p>}
      </div>
      <p className="result-title">
        {receipt.verdict_title} · {formatPoints(receipt.points)}
      </p>
      <dl className="receipt-rows">
        <div>
          <dt>Bet</dt>
          <dd>{receipt.kind === "do_it" ? "I'll do it" : "Do nothing"}</dd>
        </div>
        <div>
          <dt>Odds</dt>
          <dd>{formatOdds(receipt.band_name, receipt.odds)}</dd>
        </div>
        <div>
          <dt>Proof</dt>
          <dd>
            {receipt.evidence.text}
            {receipt.answer === null ? "" : `: ${receipt.answer}`}
          </dd>
        </div>
        {receipt.weather === null ? null : (
          <div>
            <dt>Weather</dt>
            <dd>
              {receipt.weather.label}: {weatherChips(receipt.weather.digest).join(" · ")}
            </dd>
          </div>
        )}
        <div>
          <dt>Points</dt>
          <dd>
            {formatPoints(receipt.points)} (total {formatPoints(receipt.total_points)})
          </dd>
        </div>
        {receipt.saved === null ? null : (
          <>
            <div>
              <dt>Time saved</dt>
              <dd>
                {receipt.saved.time_min === 0
                  ? "0 min"
                  : formatDuration(receipt.saved.time_min * 60)}
              </dd>
            </div>
            {receipt.saved.water_l > 0 ? (
              <div>
                <dt>Water saved</dt>
                <dd>{formatLitres(receipt.saved.water_l)}</dd>
              </div>
            ) : null}
            {receipt.saved.electricity_kwh > 0 ? (
              <div>
                <dt>Electricity saved</dt>
                <dd>{formatKwh(receipt.saved.electricity_kwh)}</dd>
              </div>
            ) : null}
          </>
        )}
      </dl>
      {receipt.saved === null ? null : (
        <p className="meta">
          {receipt.saved.assumption} ({receipt.saved.basis}).
        </p>
      )}
      {receipt.gemma_read === null ? null : (
        <div className="gemma-read">
          <p className="eyebrow">Gemma&apos;s read</p>
          <p>{receipt.gemma_read.reason}</p>
          {receipt.gemma_read.evidence.length === 0 ? null : (
            <ul>
              {receipt.gemma_read.evidence.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {receipt.lucky_win === true ? (
        <p className="meta">
          Lucky win: the recorded weather did not call for it, but the bet paid like any other win.
        </p>
      ) : null}
      {receipt.message === null ? null : <p className="loss-copy">{receipt.message}</p>}
      {receipt.multiplier < 1 && paid ? (
        <p className="meta">A photo would have paid in full; a tap or no answer pays half.</p>
      ) : null}
      <p className="meta">Settled {formatSettleTime(receipt.settled_at)}</p>
    </article>
  );
}

/**
 * "This week the sky did": net time back with both parts, water and electricity for Monday to
 * Sunday, each with the assumption behind it (AC-011.3, AC-011.5, AC-011.6).
 */
export function WeekStrip({
  totals,
  from,
  to,
}: {
  totals: SavingsTotals;
  from: string;
  to: string;
}) {
  const betsText = `${totals.bets} ${totals.bets === 1 ? "bet" : "bets"}`;
  return (
    <section className="week" aria-labelledby="week-title">
      <h2 id="week-title" className="section-title">
        This week the sky did
      </h2>
      <p className="meta">
        Monday {from} to Sunday {to}
      </p>
      <dl className="stat-tiles">
        <div>
          <dt>Net time back</dt>
          <dd>{formatNetDuration(totals.net_time_s)}</dd>
        </div>
        <div>
          <dt>Water</dt>
          <dd>{formatLitres(totals.water_l)}</dd>
        </div>
        <div>
          <dt>Electricity</dt>
          <dd>{formatKwh(totals.electricity_kwh)}</dd>
        </div>
      </dl>
      <p className="meta">
        {formatDuration(totals.time_saved_s)} saved, minus {formatDuration(totals.app_time_s)} spent
        on {betsText}.
      </p>
      {totals.assumptions.length === 0 ? (
        <p className="meta">Won bets add their savings here, with the assumption behind each.</p>
      ) : (
        <ul className="assumptions">
          {totals.assumptions.map((item) => (
            <li key={`${item.chore_type}-${item.assumption}`} className="meta">
              {item.assumption} ({item.basis}), {item.wins} won
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
