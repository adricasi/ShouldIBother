import type { CalibrationBand, Score } from "./api.js";
import {
  formatDuration,
  formatKwh,
  formatLitres,
  formatNetDuration,
  formatPoints,
} from "./format.js";
import { Nav } from "./Nav.js";
import type { Notice } from "./notice.js";

export interface ScoreScreenProps {
  /** Undefined until the first answer. */
  readonly score: Score | undefined;
  readonly flags: Readonly<Record<string, boolean>>;
  readonly notice: Notice | undefined;
}

/** Shown in place of the charts while nothing has settled (AC-020.4). */
export const SCORE_EMPTY_TEXT =
  "No settled bets yet. Once a bet settles, this shows how often doing nothing worked at each odds band, for Gemma and for the rule.";

/** The words under a band with too few bets (AC-020.3). */
export const TOO_FEW_TEXT = "too few to judge";

/** "5 bets", "1 bet": the N of a band or a rate. */
function bets(count: number): string {
  return `${count} ${count === 1 ? "bet" : "bets"}`;
}

/**
 * One calibration chart as a table: what the band promised, how often doing nothing worked, and N.
 * The bar repeats the figure for the eye (hidden from screen readers); a band under five bets
 * shows its N and "too few to judge" instead of a figure, so a shaky share never reads as a result.
 */
export function CalibrationChart({
  id,
  title,
  caption,
  bands,
}: {
  readonly id: string;
  readonly title: string;
  readonly caption: string;
  readonly bands: readonly CalibrationBand[];
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="calibration">
      <h3 id={`${id}-title`}>{title}</h3>
      <table>
        <caption className="meta">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Band</th>
            <th scope="col">Worked</th>
            <th scope="col">N</th>
          </tr>
        </thead>
        <tbody>
          {bands.map((band) => (
            <tr key={band.band}>
              <th scope="row">
                {band.name}
                <span className="meta"> · {band.predicted_pct}%</span>
              </th>
              <td>
                {band.too_few ? (
                  <span className="meta">{band.n === 0 ? "no bets" : TOO_FEW_TEXT}</span>
                ) : (
                  <>
                    <span className="bar-track" aria-hidden="true">
                      <span className="bar-fill" style={{ width: `${band.actual_pct ?? 0}%` }} />
                      <span className="bar-mark" style={{ left: `${band.predicted_pct}%` }} />
                    </span>
                    <span className="bar-figure">{band.actual_pct}%</span>
                  </>
                )}
              </td>
              <td>
                {band.n}
                {band.too_few && band.n > 0 ? (
                  <span className="meta"> · {TOO_FEW_TEXT}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SavingsTiles({ savings }: { readonly savings: Score["savings"] }) {
  return (
    <section aria-labelledby="saved-title">
      <h2 id="saved-title" className="section-title">
        What the sky saved
      </h2>
      <dl className="stat-tiles score-tiles">
        <div>
          <dt>Chores skipped</dt>
          <dd>{savings.wins}</dd>
        </div>
        <div>
          <dt>Water</dt>
          <dd>{formatLitres(savings.water_l)}</dd>
        </div>
        <div>
          <dt>Electricity</dt>
          <dd>{formatKwh(savings.electricity_kwh)}</dd>
        </div>
        <div>
          <dt>Net time back</dt>
          <dd>{formatNetDuration(savings.net_time_s)}</dd>
        </div>
      </dl>
      <p className="meta">
        {formatDuration(savings.time_saved_s)} saved, minus {formatDuration(savings.app_time_s)}{" "}
        spent on {bets(savings.bets)}.
      </p>
      {savings.assumptions.length === 0 ? (
        <p className="meta">Won bets add their savings here, with the assumption behind each.</p>
      ) : (
        <ul className="assumptions">
          {savings.assumptions.map((item) => (
            <li key={`${item.chore_type}-${item.assumption}`} className="meta">
              {item.assumption} ({item.basis}), {item.wins} won
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JudgeLine({ judge }: { readonly judge: Score["judge"] }) {
  return (
    <section aria-labelledby="judge-title">
      <h2 id="judge-title" className="section-title">
        Judge overrule rate
      </h2>
      {judge.appeals === "off" ? (
        <p>
          <strong>Appeals off.</strong>{" "}
          <span className="meta">
            Appeals are not on, so the judge has not been checked: nothing could be overruled.
          </span>
        </p>
      ) : (
        <p>
          <strong>
            {judge.rate_pct === null ? "No verdicts yet" : `${judge.rate_pct}% overruled`}
          </strong>{" "}
          <span className="meta">
            {judge.overruled} of {bets(judge.n)} (N = {judge.n}) changed on appeal.
          </span>
        </p>
      )}
    </section>
  );
}

function Calibration({ calibration }: { readonly calibration: Score["calibration"] }) {
  const { lucky_wins: lucky } = calibration;
  return (
    <section aria-labelledby="honest-title">
      <h2 id="honest-title" className="section-title">
        How honest is Gemma?
      </h2>
      {calibration.settled === 0 ? (
        <p className="empty">{SCORE_EMPTY_TEXT}</p>
      ) : (
        <>
          <p className="meta">
            Settled bets on doing nothing only. Each band's odds against how often doing nothing
            worked. Every win counts, lucky wins included. A band needs 5 bets before it says
            anything.
          </p>
          <CalibrationChart
            id="gemma"
            title="Gemma's odds"
            caption="Bets Gemma priced, under the band Gemma gave"
            bands={calibration.gemma}
          />
          <CalibrationChart
            id="rule"
            title="The rule's odds"
            caption="Every settled bet, under the band the rule gave"
            bands={calibration.rule}
          />
          <p className="meta">
            {lucky.share === null
              ? "Lucky wins: no win has been labelled yet."
              : `Lucky wins: ${lucky.lucky_wins} of ${lucky.wins_labelled} labelled wins (${Math.round(lucky.share * 100)}%) came when the weather did not match the chore's outcome. They still count as wins above.`}
          </p>
        </>
      )}
    </section>
  );
}

/** The Score screen (REQ-020): points, savings, how often the judge was overruled, calibration. */
export function ScoreScreen({ score, flags, notice }: ScoreScreenProps) {
  return (
    <>
      <main className="screen">
        <header className="header">
          <div>
            <p className="eyebrow">Your results</p>
            <h1 tabIndex={-1}>Score</h1>
          </div>
          {score === undefined ? null : (
            <p className="points">{formatPoints(score.points.total)} pts</p>
          )}
        </header>

        {notice === undefined ? null : (
          <p
            className={`notice ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )}

        {score === undefined ? (
          <p className="meta">Loading…</p>
        ) : (
          <>
            <SavingsTiles savings={score.savings} />
            <JudgeLine judge={score.judge} />
            <Calibration calibration={score.calibration} />
          </>
        )}
      </main>
      <Nav flags={flags} current="score" />
    </>
  );
}
