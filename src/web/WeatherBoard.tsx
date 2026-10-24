import type { Today, WeatherBoard as WeatherBoardData } from "./api.js";
import "./board.css";
import { formatClock } from "./format.js";
import { Icon } from "./ui/Icon.js";
import { SplitFlapText } from "./ui/SplitFlap.js";

/** The shortest a bar gets, as a share of the plot, so a dead hour is still a visible tick. */
const MIN_BAR_SHARE = 0.06;

function temperatureText(celsius: number | null): { text: string; label: string } {
  return celsius === null
    ? { text: "--°", label: "Temperature unknown" }
    : { text: `${celsius}°`, label: `${celsius} degrees` };
}

function barsLabel(board: WeatherBoardData): string {
  const first = board.hours[0];
  const last = board.hours[board.hours.length - 1];
  if (first === undefined || last === undefined) {
    return "No hourly bars for today.";
  }
  const range = `from ${String(first.hour).padStart(2, "0")}:00 to ${String(last.hour + 1).padStart(2, "0")}:00`;
  const window =
    board.lazy_window === null
      ? "No lazy window left today."
      : `Lazy window ${board.lazy_window.from} to ${board.lazy_window.to}.`;
  return `Hourly drying conditions ${range}; taller is better. ${window}`;
}

/** How old the forecast is, or that a newer one could not be fetched (AC-014.3). */
function ForecastAge({ forecast }: { readonly forecast: NonNullable<Today["forecast"]> }) {
  return (
    <p className={`board-age forecast-age${forecast.stale ? " stale" : ""}`}>
      {forecast.stale
        ? "Open-Meteo could not be reached for a newer forecast."
        : forecast.age_label}
    </p>
  );
}

/**
 * The weather board of Today (flag `splitFlap`, REQ-026): the temperature and the condition on
 * split-flap tiles, rain and wind in words, and today's daylight hours as bars with the lazy
 * window marked. `board` is null until a forecast is cached. The Open-Meteo attribution
 * (AC-014.6) is the one at the foot of Today. A forecast older than an hour says how old it is
 * instead of "Now", so the board never looks live when it is not.
 */
export function WeatherBoard({
  board,
  now,
  forecast,
}: {
  readonly board: WeatherBoardData | null;
  readonly now: string;
  /** The forecast behind the board (its age); null before the first fetch. */
  readonly forecast: Today["forecast"] | undefined;
}) {
  if (board === null) {
    return (
      <section className="weather-board empty-board" aria-labelledby="weather-board-title">
        <h2 id="weather-board-title" className="eyebrow">
          Weather board
        </h2>
        <p>No forecast yet. It appears here after your first chore gets odds.</p>
        {forecast == null ? null : <ForecastAge forecast={forecast} />}
      </section>
    );
  }
  const temperature = temperatureText(board.temperature_c);
  return (
    <section className="weather-board" aria-labelledby="weather-board-title">
      <div className="board-head">
        <h2 id="weather-board-title" className="eyebrow">
          {board.place_label === undefined ? (
            "Weather board"
          ) : (
            <>
              <span className="sr-only">Weather board · </span>
              {board.place_label}
            </>
          )}
        </h2>
        <p className="eyebrow board-live">
          {forecast?.stale === true ? null : <span className="live-dot" aria-hidden="true" />}
          {forecast?.stale === true ? forecast.age_label : `Now ${formatClock(now)}`}
        </p>
      </div>
      <div className="board-now">
        <SplitFlapText text={temperature.text} label={temperature.label} />
        <div className="board-words">
          <SplitFlapText text={board.condition} label={board.condition} size="small" />
          <p className="board-facts">
            <span>
              <Icon name="rain" /> Rain {board.rain_pct === null ? "unknown" : `${board.rain_pct}%`}
            </span>
            <span>
              <Icon name="wind" /> Wind{" "}
              {board.wind_kmh === null ? "unknown" : `${board.wind_kmh} km/h`}
            </span>
          </p>
        </div>
      </div>
      {board.hours.length === 0 ? null : (
        <div className="bars" role="img" aria-label={barsLabel(board)}>
          {board.hours.map((hour) => (
            <span key={hour.hour} className="bar-slot">
              <span className="bar-plot">
                <span
                  className={`bar${hour.lazy ? " lazy" : ""}`}
                  style={{
                    height: `${Math.round(Math.max(hour.level ?? 0, MIN_BAR_SHARE) * 100)}%`,
                  }}
                />
              </span>
              <span className="bar-hour">
                {hour.hour % 3 === 0 ? String(hour.hour).padStart(2, "0") : ""}
              </span>
            </span>
          ))}
        </div>
      )}
      <p className="board-window">
        {board.lazy_window === null ? (
          <span className="window-tag none">No lazy window left today</span>
        ) : (
          <span className="window-tag">
            Lazy window {board.lazy_window.from} to {board.lazy_window.to}
          </span>
        )}
        <span className="board-source">Bars: how well the line would dry</span>
      </p>
      {forecast == null ? null : <ForecastAge forecast={forecast} />}
    </section>
  );
}
